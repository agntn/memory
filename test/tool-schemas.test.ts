import { readFile } from "node:fs/promises";
import type { ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import ompMemoryExtension from "../extensions/omp/memory.ts";
import * as sharedSchemas from "../extensions/shared/memory-tool-schemas.ts";
import {
  MAX_TOOL_LIST_LIMIT,
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MAX_TOOL_MESSAGE_CHARACTERS,
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_NAME_PATTERN,
  memoryToolMeta,
} from "../extensions/shared/memory-tools.ts";
import { cloudflareMemoryLimits } from "../src/index.ts";
import { createMcpServer } from "../src/mcp.ts";
import { version } from "../src/version.ts";

vi.mock("@oh-my-pi/pi-tui", () => ({ Text: class Text {} }));

/** OMP's host `Type.Unsafe` emits the JSON Schema it gets; standalone omptype shares one object. */
const ompTypebox = { Type: { Unsafe: (schema: unknown) => schema } };

interface FieldShape {
  optional: boolean;
  /** `maxLength` for strings, `maximum` for integers, `maxItems` for arrays. */
  max?: number;
  description?: string;
  /** `minLength` for strings, `minimum` for integers, `minItems` for arrays. */
  min?: number;
  pattern?: string;
}

interface JsonSchemaValue {
  type?: string;
  maxLength?: number;
  maximum?: number;
  maxItems?: number;
  minLength?: number;
  minimum?: number;
  minItems?: number;
  pattern?: string;
  description?: string;
  properties?: Record<string, JsonSchemaValue>;
  required?: string[];
  items?: JsonSchemaValue;
}

function sharedMaximum(value: JsonSchemaValue): number | undefined {
  return value.maxLength ?? value.maximum ?? value.maxItems;
}

function sharedMinimum(value: JsonSchemaValue): number | undefined {
  return value.minLength ?? value.minimum ?? value.minItems;
}

function sharedField(value: JsonSchemaValue, optional: boolean): FieldShape {
  const field: FieldShape = { optional };
  const max = sharedMaximum(value);
  const min = sharedMinimum(value);
  if (max !== undefined) field.max = max;
  if (min !== undefined) field.min = min;
  if (value.pattern !== undefined) field.pattern = value.pattern;
  if (value.description !== undefined) field.description = value.description;
  return field;
}

function sharedArrayItem(value: JsonSchemaValue): FieldShape {
  return sharedField(
    {
      maxLength: value.maxLength,
      maximum: value.maximum,
      minLength: value.minLength,
      minimum: value.minimum,
      pattern: value.pattern,
      description: value.description,
    },
    false,
  );
}

/**
 * Flatten a schema to `path -> shape`, descending into objects and array items.
 *
 * Comparing only the top level would let a rewritten `messages[].role` or a
 * shrunken `messages[].content` pass unnoticed.
 */
function sharedShape(schema: unknown, prefix = ""): Record<string, FieldShape> {
  const object = schema as JsonSchemaValue;
  const required = new Set(object.required ?? []);
  const shape: Record<string, FieldShape> = {};
  for (const [key, value] of Object.entries(object.properties ?? {})) {
    const path = `${prefix}${key}`;
    shape[path] = sharedField(value, !required.has(key));
    if (value.properties) Object.assign(shape, sharedShape(value, `${path}.`));
    if (value.items?.properties) Object.assign(shape, sharedShape(value.items, `${path}[].`));
    else if (value.items) shape[`${path}[]`] = sharedArrayItem(value.items);
  }
  return shape;
}

function ompToolParameters(): Map<string, unknown> {
  const parameters = new Map<string, unknown>();
  ompMemoryExtension({
    typebox: ompTypebox,
    setLabel() {},
    registerTool(tool: { name: string; parameters: unknown }) {
      parameters.set(tool.name, tool.parameters);
    },
  } as unknown as OmpExtensionAPI);
  return parameters;
}

/** Tool name to the schema every surface publishes for it. */
const sharedToolSchemas: Record<keyof typeof memoryToolMeta, unknown> = {
  memory_namespace_list: sharedSchemas.namespaceListParameters,
  memory_namespace_get: sharedSchemas.namespaceParameters,
  memory_namespace_create: sharedSchemas.namespaceParameters,
  memory_namespace_delete: sharedSchemas.namespaceParameters,
  memory_profile_list: sharedSchemas.profileListParameters,
  memory_remember: sharedSchemas.rememberParameters,
  memory_supersede: sharedSchemas.supersedeParameters,
  memory_supersession_resume: sharedSchemas.resumeSupersessionParameters,
  memory_recall_wait: sharedSchemas.recallVisibilityParameters,
  memory_ingest: sharedSchemas.ingestParameters,
  memory_recall: sharedSchemas.recallParameters,
  memory_list: sharedSchemas.listParameters,
  memory_get: sharedSchemas.getParameters,
  memory_delete: sharedSchemas.memoryParameters,
  memory_summary: sharedSchemas.summaryParameters,
  memory_session_delete: sharedSchemas.sessionParameters,
  memory_profile_delete: sharedSchemas.profileOnlyParameters,
};

describe("tool schemas", () => {
  it("publishes the bounds the Cloudflare provider enforces", () => {
    expect(MAX_TOOL_PROFILE_CHARACTERS).toBe(cloudflareMemoryLimits.profileNameCharacters);
    expect(MAX_TOOL_SESSION_ID_CHARACTERS).toBe(cloudflareMemoryLimits.sessionIdCharacters);
    expect(MAX_TOOL_QUERY_CHARACTERS).toBeLessThanOrEqual(cloudflareMemoryLimits.queryBytes);
    expect(MAX_TOOL_MESSAGE_CHARACTERS).toBeLessThanOrEqual(cloudflareMemoryLimits.messageBytes);

    const remember = sharedShape(sharedSchemas.rememberParameters);
    expect(remember.namespace?.max).toBe(cloudflareMemoryLimits.namespaceNameCharacters);
    expect(remember.profile?.max).toBe(cloudflareMemoryLimits.profileNameCharacters);
    expect(remember.sessionId?.max).toBe(cloudflareMemoryLimits.sessionIdCharacters);

    const visibility = sharedShape(sharedSchemas.recallVisibilityParameters);
    expect(visibility.memoryId?.pattern).toBeTruthy();
    expect(visibility.query?.max).toBe(MAX_TOOL_QUERY_CHARACTERS);
    expect(visibility.timeoutSeconds?.min).toBe(1);
    expect(visibility.timeoutSeconds?.max).toBe(300);

    const ingest = sharedShape(sharedSchemas.ingestParameters);
    expect(ingest.messages?.max).toBe(cloudflareMemoryLimits.ingestMessages);
    expect(MEMORY_NAME_PATTERN).toBe(cloudflareMemoryLimits.namePattern);
    expect(MAX_TOOL_NAMESPACE_CHARACTERS).toBe(cloudflareMemoryLimits.namespaceNameCharacters);
    expect(MAX_TOOL_LIST_LIMIT).toBeLessThanOrEqual(cloudflareMemoryLimits.httpListLimit);
  });

  it("caps stored memory content where the service does", () => {
    expect(MAX_TOOL_MEMORY_CONTENT_CHARACTERS).toBeLessThanOrEqual(
      cloudflareMemoryLimits.memoryContentBytes,
    );
    const remember = sharedShape(sharedSchemas.rememberParameters);
    const supersede = sharedShape(sharedSchemas.supersedeParameters);
    expect(remember.content?.max).toBe(MAX_TOOL_MEMORY_CONTENT_CHARACTERS);
    expect(supersede.content?.max).toBe(MAX_TOOL_MEMORY_CONTENT_CHARACTERS);
  });

  it("reports the package version", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(version).toBe(packageJson.version);
  });

  it("hands OMP the shared schema of every tool unchanged", () => {
    const ompParameters = ompToolParameters();
    expect([...ompParameters.keys()]).toEqual(Object.keys(sharedToolSchemas));
    for (const [name, schema] of Object.entries(sharedToolSchemas)) {
      expect(ompParameters.get(name), name).toEqual(schema);
    }
  });

  it("describes every namespace and profile argument", () => {
    for (const [name, schema] of Object.entries(sharedToolSchemas)) {
      for (const [field, shape] of Object.entries(sharedShape(schema))) {
        expect(shape.description, `${name}.${field} description`).toBeTruthy();
      }
    }
  });
});

describe("tool metadata", () => {
  it("names the same tools the MCP server publishes", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "schema-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(memoryToolMeta));
    for (const tool of tools) {
      const meta = memoryToolMeta[tool.name as keyof typeof memoryToolMeta];
      expect(tool.title).toBe(meta.label);
      expect(tool.description).toBe(meta.description);
    }

    await Promise.all([client.close(), server.close()]);
  });
});
