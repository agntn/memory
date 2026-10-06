import { readFile } from "node:fs/promises";
import * as OmpTypebox from "@oh-my-pi/omptype/typebox";
import type { ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import ompMemoryExtension from "../packages/omp/extensions/memory.ts";
import * as sharedSchemas from "../packages/shared/memory-tool-schemas.ts";
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
} from "../packages/shared/memory-tools.ts";
import { cloudflareMemoryLimits } from "../src/index.ts";
import { createMcpServer } from "../src/mcp.ts";
import { version } from "../src/version.ts";

vi.mock("@oh-my-pi/pi-tui", () => ({ Text: class Text {} }));

interface FieldShape {
  optional: boolean;
  /** `maxLength` for strings, `maximum` for integers, `maxItems` for arrays. */
  max?: number;
  description?: string;
  /** `minLength` for strings, `minimum` for integers, `minItems` for arrays. */
  min?: number;
  pattern?: string;
  /** OMP hides the bounds of pattern-constrained strings behind a refinement. */
  opaque?: boolean;
  /** Accepted literal values, for union-of-literals fields such as role or type. */
  literals?: string[];
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
  anyOf?: Array<{ const?: unknown }>;
  const?: unknown;
}

interface OmpIrValue {
  k?: string;
  v?: unknown;
  max?: number;
  min?: number;
  desc?: string;
  descAuto?: boolean;
  props?: Array<{ key: string; opt: boolean; val?: OmpIrValue }>;
  el?: OmpIrValue;
  members?: OmpIrValue[];
}

function sharedMaximum(value: JsonSchemaValue): number | undefined {
  return value.maxLength ?? value.maximum ?? value.maxItems;
}

function sharedMinimum(value: JsonSchemaValue): number | undefined {
  return value.minLength ?? value.minimum ?? value.minItems;
}

function sharedLiterals(value: JsonSchemaValue): string[] | undefined {
  return value.anyOf?.map((variant) => String(variant.const)).sort();
}

function sharedField(value: JsonSchemaValue, optional: boolean): FieldShape {
  const field: FieldShape = { optional };
  const max = sharedMaximum(value);
  const min = sharedMinimum(value);
  const literals = sharedLiterals(value);
  if (max !== undefined) field.max = max;
  if (min !== undefined) field.min = min;
  if (value.pattern !== undefined) field.pattern = value.pattern;
  if (value.description !== undefined) field.description = value.description;
  if (literals !== undefined) field.literals = literals;
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

function ompLiterals(value: OmpIrValue): string[] | undefined {
  if (value.k !== "union" || !value.members?.every((member) => member.k === "lit")) {
    return undefined;
  }
  return value.members.map((member) => String(member.v)).sort();
}

function ompField(value: OmpIrValue, optional: boolean): FieldShape {
  const field: FieldShape = { optional };
  const literals = ompLiterals(value);
  if (value.max !== undefined) field.max = value.max;
  if (value.min !== undefined) field.min = value.min;
  if (value.k === "sub") field.opaque = true;
  if (value.desc !== undefined && value.descAuto !== true) field.description = value.desc;
  if (literals !== undefined) field.literals = literals;
  return field;
}

function addOmpChildren(shape: Record<string, FieldShape>, value: OmpIrValue, path: string): void {
  if (value.props) Object.assign(shape, ompShape(value, `${path}.`));
  if (value.el?.props) Object.assign(shape, ompShape(value.el, `${path}[].`));
  else if (value.el) shape[`${path}[]`] = ompField(value.el, false);
}

function ompShape(schema: unknown, prefix = ""): Record<string, FieldShape> {
  // A registered OMP schema exposes its shape under `ir`; nested values are plain IR nodes.
  const object = ((schema as { ir?: OmpIrValue }).ir ?? schema) as OmpIrValue;
  const shape: Record<string, FieldShape> = {};
  for (const property of object.props ?? []) {
    const path = `${prefix}${property.key}`;
    const value = property.val ?? {};
    shape[path] = ompField(value, property.opt);
    addOmpChildren(shape, value, path);
  }
  return shape;
}

function ompToolParameters(): Map<string, unknown> {
  const parameters = new Map<string, unknown>();
  ompMemoryExtension({
    typebox: OmpTypebox,
    setLabel() {},
    registerTool(tool: { name: string; parameters: unknown }) {
      parameters.set(tool.name, tool.parameters);
    },
  } as unknown as OmpExtensionAPI);
  return parameters;
}

/** Tool name to the schema Pi and MCP publish for it. */
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

function expectFieldAlignment(
  name: string,
  field: string,
  sharedField: FieldShape,
  ompFieldValue: FieldShape | undefined,
): void {
  const actual: Partial<FieldShape> = ompFieldValue ?? {};
  expect(actual.optional, `${name}.${field} optionality`).toBe(sharedField.optional);
  expect(actual.description, `${name}.${field} description`).toBe(sharedField.description);
  expect(actual.literals, `${name}.${field} accepted values`).toEqual(sharedField.literals);
  if (sharedField.pattern !== undefined) {
    expect(actual.opaque, `${name}.${field} pattern-backed refinement`).toBe(true);
  }
  if (actual.opaque === true) {
    expect(sharedField.pattern, `${name}.${field} opacity explained by a pattern`).toBeTruthy();
    return;
  }
  expect(actual.max, `${name}.${field} upper bound`).toBe(sharedField.max);
  expect(actual.min, `${name}.${field} lower bound`).toBe(sharedField.min);
}

function expectSchemaAlignment(
  name: string,
  schema: unknown,
  ompParameters: ReadonlyMap<string, unknown>,
): void {
  const omp = ompParameters.get(name);
  expect(omp, `OMP registers ${name}`).toBeDefined();
  const ompFields = ompShape(omp);
  const sharedFields = sharedShape(schema);
  expect(Object.keys(ompFields).sort(), `OMP fields for ${name}`).toEqual(
    Object.keys(sharedFields).sort(),
  );
  for (const [field, sharedField] of Object.entries(sharedFields)) {
    expectFieldAlignment(name, field, sharedField, ompFields[field]);
  }
}

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

  it("keeps the OMP copies aligned with the shared schemas", () => {
    const ompParameters = ompToolParameters();
    for (const [name, schema] of Object.entries(sharedToolSchemas)) {
      expectSchemaAlignment(name, schema, ompParameters);
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
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
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
