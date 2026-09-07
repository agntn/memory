#!/usr/bin/env node
// Packed-package smoke test for every published entry: the Pi and OMP extensions
// and the MCP server.
//
// Unit tests always run from the checkout, where the shared executors load
// src/index.ts directly. The published tarball ships no src/, so there the
// executors resolve "@agntn/memory" through the package's own export map
// instead. That distribution path never runs in the repository, which is why
// this test packs the real tarball, loads every entry from it, and executes one
// tool per surface against a stubbed fetch. A missing file in "files", a broken
// export map, or a dist layout the self-reference cannot resolve surfaces here
// and nowhere else.
//
// Run: pnpm test:packed

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as OmpTypeBox from "@oh-my-pi/omptype/typebox";

const root = path.resolve(import.meta.dirname, "..");

// Assert the raw multi-profile surface even when the contributor's shell carries
// the bound production scope, and keep the Pi file fallback away from any real
// ~/.pi configuration. The credentials are fake on purpose: every request must
// end in the fetch stub below, and a request that escapes the stub then dies on
// Cloudflare's auth check instead of writing under a real account.
for (const key of [
  "AGNTN_MEMORY_NAMESPACE",
  "AGNTN_MEMORY_PROFILE",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SESSION_ID",
]) {
  delete process.env[key];
}
process.env.PI_CODING_AGENT_DIR = "/nonexistent/agntn-memory-packed-test";
process.env.CLOUDFLARE_ACCOUNT_ID = "packed-account";
process.env.CLOUDFLARE_API_TOKEN = "packed-token";

const expectedToolNames = [
  "memory_namespace_list",
  "memory_namespace_get",
  "memory_namespace_create",
  "memory_namespace_delete",
  "memory_profile_list",
  "memory_remember",
  "memory_supersede",
  "memory_resume_supersession",
  "memory_wait_for_recall",
  "memory_ingest",
  "memory_recall",
  "memory_list",
  "memory_get",
  "memory_delete",
  "memory_summary",
  "memory_delete_session",
  "memory_delete_profile",
];

const memoryResult = {
  id: "packed-memory-1",
  type: "fact",
  summary: "packed",
  content: "packed",
  sessionId: null,
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
};
const requests = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  requests.push({
    url,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  });
  const result = url.endsWith("/recall")
    ? {
        count: 1,
        answer: "packed recall answer",
        candidates: [
          { id: memoryResult.id, summary: memoryResult.summary, sessionId: null, score: 1 },
        ],
      }
    : memoryResult;
  return Response.json({ success: true, result });
};

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Load one packed extension through a host stub and return what it registered. */
async function registerPacked(extensionPath, api) {
  const extension = await import(pathToFileURL(extensionPath).href);
  const tools = new Map();
  extension.default({
    ...api,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  assert.deepEqual([...tools.keys()], expectedToolNames, `wrong tool set in ${extensionPath}`);
  return tools;
}

const temporaryRoot = await mkdtemp(path.join(root, ".memory-packed-test-"));
try {
  // pnpm pack runs prepack, so the tarball always carries a fresh build.
  const tarball = path.join(temporaryRoot, "memory.tgz");
  run("pnpm", ["pack", "--out", tarball]);
  run("tar", ["-xzf", tarball, "-C", temporaryRoot]);

  const packageRoot = path.join(temporaryRoot, "package");
  for (const entry of [
    "dist/index.mjs",
    "dist/cli.mjs",
    "dist/mcp.mjs",
    "packages/shared/memory-tools.ts",
    "packages/pi/extensions/memory.ts",
    "packages/omp/extensions/memory.ts",
  ]) {
    assert.ok(existsSync(path.join(packageRoot, entry)), `packed tarball is missing ${entry}`);
  }
  assert.ok(
    !existsSync(path.join(packageRoot, "src/index.ts")),
    "packed tarball ships src/, so the checkout source loader would mask the distribution path",
  );

  // The OMP extension renders through @oh-my-pi/pi-tui, whose real build imports
  // Bun modules and cannot load under Node. The unit tests mock it the same way;
  // a stub inside the unpacked package shadows it for every module loaded from
  // there while the rest of the tarball resolves exactly as installed.
  const stubRoot = path.join(packageRoot, "node_modules", "@oh-my-pi", "pi-tui");
  await mkdir(stubRoot, { recursive: true });
  await writeFile(
    path.join(stubRoot, "package.json"),
    JSON.stringify({ name: "@oh-my-pi/pi-tui", version: "0.0.0", main: "./index.mjs" }),
  );
  await writeFile(path.join(stubRoot, "index.mjs"), "export class Text {}\n");

  const ompTools = await registerPacked(
    path.join(packageRoot, "packages/omp/extensions/memory.ts"),
    { typebox: OmpTypeBox, setLabel() {} },
  );
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "packed-conversation" } };
  const remembered = await ompTools
    .get("memory_remember")
    .execute(
      "packed-omp",
      { namespace: "packed", profile: "agent", content: "one packed memory" },
      undefined,
      undefined,
      ctx,
    );
  assert.match(remembered.content[0].text, /packed-memory-1/);
  const rememberRequest = requests.at(-1);
  assert.match(rememberRequest.url, /\/namespaces\/packed\/profiles\/agent\/remember$/);
  assert.equal(rememberRequest.body.content, "one packed memory");
  // A write without a caller session still carries the harness-derived one.
  assert.match(rememberRequest.body.sessionId, /^omp-[a-z0-9-]+-[0-9a-f]{16}$/);

  const visible = await ompTools.get("memory_wait_for_recall").execute("packed-wait", {
    namespace: "packed",
    profile: "agent",
    memoryId: memoryResult.id,
    query: "packed",
    timeoutSeconds: 5,
  });
  assert.match(visible.content[0].text, /"packed-memory-1" reached recall/);

  // The Pi extension ships from the same tarball and reaches the library through
  // the shared executors, so it has to work from the packed layout too.
  const piTools = await registerPacked(
    path.join(packageRoot, "packages/pi/extensions/memory.ts"),
    {},
  );
  const recalled = await piTools
    .get("memory_recall")
    .execute("packed-pi", { namespace: "packed", profile: "agent", query: "what is packed?" });
  assert.match(recalled.content[0].text, /answerTrust: "service-generated-untrusted"/);
  assert.match(recalled.content[0].text, /packed recall answer/);
  assert.match(requests.at(-1).url, /\/namespaces\/packed\/profiles\/agent\/recall$/);

  // The MCP bundle is the only entry that carries the SDK and typebox, so a
  // missing dependency or a chunk split surfaces here first.
  const { createMcpServer } = await import(
    pathToFileURL(path.join(packageRoot, "dist/mcp.mjs")).href
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "packed-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      expectedToolNames,
      "wrong tool set from packed dist/mcp.mjs",
    );
    const response = await client.callTool({
      name: "memory_remember",
      arguments: { namespace: "packed", profile: "agent", content: "one packed mcp memory" },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    assert.match(response.content[0].text, /packed-memory-1/);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }

  console.log(
    `Packed entries served ${expectedToolNames.length} tools each on Pi, OMP and MCP against the stubbed API`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
