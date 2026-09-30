import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as OmpTypebox from "@oh-my-pi/omptype/typebox";
import piMemoryExtension from "../packages/pi/extensions/memory.ts";
import ompMemoryExtension from "../packages/omp/extensions/memory.ts";
import { painted, type RegisteredTool } from "./extensions.types.ts";
import { memoryToolExecutors, memoryToolProgress } from "../packages/shared/memory-tools.ts";

/**
 * Keep the rendered string so a test can read what the harness would print.
 *
 * Each factory declares its own class because `vi.mock` is hoisted above every
 * declaration in this file.
 */
vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  },
}));
vi.mock("@oh-my-pi/pi-tui", () => ({
  Text: class Text {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  },
}));

const expectedNames = [
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

function sharedListLimit(parameters: RegisteredTool["parameters"] | undefined): number | undefined {
  return parameters?.properties?.limit?.maximum;
}

function ompListLimit(parameters: RegisteredTool["parameters"] | undefined): number | undefined {
  return parameters?.ir?.props?.find((property) => property.key === "limit")?.val?.max;
}

function listLimit(tools: RegisteredTool[]): number | undefined {
  const parameters = tools.find((tool) => tool.name === "memory_list")?.parameters;
  return sharedListLimit(parameters) ?? ompListLimit(parameters);
}

function requiredFields(tool: RegisteredTool): string[] {
  const required = tool.parameters.required;
  if (Array.isArray(required)) return required;
  return (
    tool.parameters.ir?.props
      ?.filter((property) => property.opt === false)
      .map((property) => property.key)
      .filter((key): key is string => typeof key === "string") ?? []
  );
}

function requiresNamespace(tool: RegisteredTool): boolean {
  return requiredFields(tool).includes("namespace");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("memory extensions", () => {
  it("registers the complete Pi tool surface", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    const tools = piTools();

    expect(tools.map((tool) => tool.name)).toEqual(expectedNames);
    expect(listLimit(tools)).toBe(100);
    expect(
      tools.filter((tool) => tool.name !== "memory_namespace_list").every(requiresNamespace),
    ).toBe(true);
    expect(requiresNamespace(tools[0]!)).toBe(false);
  });

  it("registers the complete OMP tool surface with native approvals", () => {
    const tools = ompTools();

    expect(tools.map((tool) => tool.name)).toEqual(expectedNames);
    expect(listLimit(tools)).toBe(100);
    expect(
      tools.filter((tool) => tool.name !== "memory_namespace_list").every(requiresNamespace),
    ).toBe(true);
    expect(requiresNamespace(tools[0]!)).toBe(false);
    expect(tools.map((tool) => tool.approval)).toEqual([
      "read",
      "read",
      "write",
      "write",
      "read",
      "write",
      "write",
      "write",
      "read",
      "write",
      "read",
      "read",
      "read",
      "write",
      "read",
      "write",
      "write",
    ]);
  });

  it("binds Pi operational tools to the canonical scope and session", async () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    const tools = piTools();
    const remember = tools.find((tool) => tool.name === "memory_remember") as
      | (RegisteredTool & {
          execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
        })
      | undefined;
    expect(remember).toBeDefined();
    expect(requiresNamespace(remember!)).toBe(false);
    expect(requiredFields(remember!)).toEqual(["content"]);
    const execute = vi
      .spyOn(memoryToolExecutors, "remember")
      .mockResolvedValue({ content: [{ type: "text", text: "remembered" }], details: {} });

    const { signal } = new AbortController();
    await remember!.execute(
      "call-1",
      { content: "canonical", sessionId: "model-selected-session" },
      signal,
      undefined,
      {
        cwd: "/workspace/movie-enigma",
        sessionManager: { getSessionId: () => "pi-session-123" },
      },
    );

    expect(execute).toHaveBeenCalledWith(
      {
        namespace: "default",
        profile: "oritwoen",
        content: "canonical",
        sessionId: expect.stringMatching(/^pi-movie-enigma-[0-9a-f]{16}$/),
      },
      { signal },
    );
  });

  it("binds Pi operational tools from its agent-local scope file", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    try {
      writeFileSync(
        join(agentDir, "memory-scope.json"),
        JSON.stringify({ namespace: "default", profile: "oritwoen" }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      const tools = piTools();
      const remember = tools.find((tool) => tool.name === "memory_remember") as
        | (RegisteredTool & {
            execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
          })
        | undefined;
      expect(remember).toBeDefined();
      expect(requiredFields(remember!)).toEqual(["content"]);
      expect(requiresNamespace(remember!)).toBe(false);
      const execute = vi
        .spyOn(memoryToolExecutors, "remember")
        .mockResolvedValue({ content: [{ type: "text", text: "remembered" }], details: {} });

      const { signal } = new AbortController();
      await remember!.execute("call-1", { content: "canonical" }, signal, undefined, {
        cwd: "/workspace/movie-enigma",
        sessionManager: { getSessionId: () => "pi-session-file" },
      });

      expect(execute).toHaveBeenCalledWith(
        {
          namespace: "default",
          profile: "oritwoen",
          content: "canonical",
          sessionId: expect.stringMatching(/^pi-movie-enigma-[0-9a-f]{16}$/),
        },
        { signal },
      );
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("fails closed when Pi's scope file cannot be read", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    try {
      mkdirSync(join(agentDir, "memory-scope.json"));
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

      expect(() =>
        piMemoryExtension({
          registerTool() {},
        } as unknown as PiExtensionAPI),
      ).toThrow("Cannot read Pi memory scope");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("binds OMP operational tools to the canonical scope and session", async () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    const tools = ompTools();
    const remember = tools.find((tool) => tool.name === "memory_remember") as
      | (RegisteredTool & {
          execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
        })
      | undefined;
    expect(remember).toBeDefined();
    expect(requiresNamespace(remember!)).toBe(false);
    expect(requiredFields(remember!)).toEqual(["content"]);
    const execute = vi
      .spyOn(memoryToolExecutors, "remember")
      .mockResolvedValue({ content: [{ type: "text", text: "remembered" }], details: {} });

    const { signal } = new AbortController();
    await remember!.execute(
      "call-1",
      { content: "canonical", sessionId: "model-selected-session" },
      signal,
      undefined,
      {
        cwd: "/workspace/movie-enigma",
        sessionManager: { getSessionId: () => "omp-session-123" },
      },
    );

    expect(execute).toHaveBeenCalledWith(
      {
        namespace: "default",
        profile: "oritwoen",
        content: "canonical",
        sessionId: expect.stringMatching(/^omp-movie-enigma-[0-9a-f]{16}$/),
      },
      { signal },
    );
  });

  it("gives the OMP extension a display label", () => {
    const labels: string[] = [];

    ompMemoryExtension({
      typebox: OmpTypebox,
      setLabel: (label: string) => labels.push(label),
      registerTool() {},
    } as unknown as OmpExtensionAPI);

    expect(labels).toEqual(["Memory"]);
  });

  it("streams a progress line while recall visibility is pending", async () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    const execute = vi.spyOn(memoryToolExecutors, "waitForRecall").mockResolvedValue({
      content: [{ type: "text", text: "visible" }],
      details: {},
    });
    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
    const controllers = [new AbortController(), new AbortController()];

    for (const [index, tools] of [piTools(), ompTools()].entries()) {
      const wait = tools.find((tool) => tool.name === "memory_wait_for_recall") as
        | (RegisteredTool & {
            execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
          })
        | undefined;
      expect(wait).toBeDefined();
      await wait!.execute(
        "call-1",
        { memoryId: "mem-1", query: "durable marker", timeoutSeconds: 30 },
        controllers[index]?.signal,
        (update: unknown) => updates.push(update as AgentToolResult<Record<string, unknown>>),
      );
    }

    expect(execute).toHaveBeenNthCalledWith(
      1,
      {
        namespace: "default",
        profile: "oritwoen",
        memoryId: "mem-1",
        query: "durable marker",
        timeoutSeconds: 30,
      },
      { signal: controllers[0]?.signal },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      {
        namespace: "default",
        profile: "oritwoen",
        memoryId: "mem-1",
        query: "durable marker",
        timeoutSeconds: 30,
      },
      { signal: controllers[1]?.signal },
    );
    expect(updates).toHaveLength(2);
    expect(
      updates.map((update) => {
        const first = update.content[0];
        return first?.type === "text" ? first.text : undefined;
      }),
    ).toEqual([
      memoryToolProgress.memory_wait_for_recall,
      memoryToolProgress.memory_wait_for_recall,
    ]);
  });

  it("streams a progress line before a recall answers", async () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    const recall = ompTools().find((tool) => tool.name === "memory_recall") as
      | (RegisteredTool & {
          execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
        })
      | undefined;
    expect(recall).toBeDefined();
    vi.spyOn(memoryToolExecutors, "recall").mockResolvedValue({
      content: [{ type: "text", text: "recalled" }],
      details: {},
    });
    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];

    await recall!.execute("call-1", { query: "what do we know" }, undefined, (update: unknown) => {
      updates.push(update as AgentToolResult<Record<string, unknown>>);
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.content[0]).toMatchObject({ text: memoryToolProgress.memory_recall });
  });

  it("selects the Cloudflare namespace independently for every tool call", async () => {
    const urls: string[] = [];
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({
          success: true,
          result: {
            id: `memory-${urls.length}`,
            type: "fact",
            summary: "remembered",
            content: "remembered",
            sessionId: null,
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
        });
      }),
    );

    try {
      await memoryToolExecutors.remember({
        namespace: "first",
        profile: "agent",
        content: "one",
      });
      await memoryToolExecutors.remember({
        namespace: "second",
        profile: "agent",
        content: "two",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/namespaces/first/profiles/agent/remember");
    expect(urls[1]).toContain("/namespaces/second/profiles/agent/remember");
  });

  it("ignores empty optional strings emitted by an extension host", async () => {
    const urls: string[] = [];
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({ success: true, result: [] });
      }),
    );

    try {
      await memoryToolExecutors.list({
        namespace: "empty-option-test",
        profile: "agent",
        limit: 1,
        cursor: "",
        sessionId: "",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }

    expect(urls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account/agent-memory/namespaces/empty-option-test/profiles/agent/memories?per_page=1",
    ]);
  });
});

function piTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  piMemoryExtension({
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as PiExtensionAPI);
  return tools;
}

function ompTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  ompMemoryExtension({
    typebox: OmpTypebox,
    setLabel() {},
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as OmpExtensionAPI);
  return tools;
}

function tool(tools: RegisteredTool[], name: string): RegisteredTool {
  const found = tools.find((candidate) => candidate.name === name);
  expect(found).toBeDefined();
  return found!;
}

describe("memory tool renderers", () => {
  it("renders a Pi call line with Pi's argument order", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    const recall = tool(piTools(), "memory_recall");

    const { text } = recall.renderCall!(
      { namespace: "default", profile: "oritwoen", query: "what do I know" },
      painted,
      { isPartial: false, expanded: false },
    );

    expect(text).toBe(
      "<success>✓ <accent>🔎 <toolTitle><b>Recall <dim>what do I know <muted>default/oritwoen",
    );
  });

  it("renders an OMP call line with OMP's argument order", () => {
    const recall = tool(ompTools(), "memory_recall");

    const { text } = recall.renderCall!(
      { namespace: "default", profile: "oritwoen", query: "what do I know" },
      { isPartial: true, expanded: false, spinnerFrame: 3 },
      painted,
    );

    expect(text).toBe(
      "<accent>⠸ <accent>🔎 <toolTitle><b>Recall <dim>what do I know <muted>default/oritwoen",
    );
  });

  it("names the bound profile the model never passed", () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");

    for (const tools of [piTools(), ompTools()]) {
      const { text } = tool(tools, "memory_recall").renderCall!({ query: "bound" }, {}, {});
      expect(text).toContain("default/oritwoen");
    }
  });

  it("leaves the profile out of a namespace call, which has none", () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");

    for (const tools of [piTools(), ompTools()]) {
      const create = tool(tools, "memory_namespace_create");
      const { text } = create.renderCall!({ namespace: "scratch" }, {}, {});
      expect(text).toContain("scratch");
      expect(text).not.toContain("oritwoen");
    }
  });

  it("reads a Pi failure from the render context, which is the only place it is", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    const get = tool(piTools(), "memory_get");

    const { text } = get.renderResult!(
      { content: [{ type: "text", text: "404: no such memory" }], details: {} },
      { expanded: false, isPartial: false },
      painted,
      { isError: true },
    );

    expect(text).toBe("<error>✗ <dim>404: no such memory <accent>(failed)");
  });

  it("reads an OMP failure from the result object, which is where OMP puts it", () => {
    const get = tool(ompTools(), "memory_get");

    const { text } = get.renderResult!(
      { content: [{ type: "text", text: "404: no such memory" }], details: {}, isError: true },
      { expanded: false, isPartial: false },
      painted,
    );

    expect(text).toBe("<error>✗ <dim>404: no such memory <accent>(failed)");
  });

  it("keeps the tool name out of the result line both harnesses print below the call", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    const result = {
      content: [{ type: "text", text: "stored" }],
      details: { id: "01M0", type: "fact" },
    };

    for (const tools of [piTools(), ompTools()]) {
      const { text } = tool(tools, "memory_remember").renderResult!(result, {}, painted, {});
      expect(text).toContain("01M0");
      expect(text).not.toContain("Remember");
    }
  });

  it("uses the same memory-specific emoji in both harnesses", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");

    const calls = [
      tool(piTools(), "memory_remember").renderCall!({ content: "keep this" }, painted, {}),
      tool(ompTools(), "memory_remember").renderCall!({ content: "keep this" }, {}, painted),
    ];

    for (const { text } of calls) expect(text).toContain("🧠");
  });

  it("strips terminal control sequences out of arguments in both harnesses", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    const query = `${String.fromCodePoint(27)}[2Jwiped${String.fromCodePoint(0)}query`;

    const pi = tool(piTools(), "memory_recall").renderCall!({ query }, painted, {});
    const omp = tool(ompTools(), "memory_recall").renderCall!({ query }, {}, painted);

    for (const { text } of [pi, omp]) {
      expect(text).toContain("wiped query");
      expect(text).not.toContain(String.fromCodePoint(27));
      expect(text).not.toContain(String.fromCodePoint(0));
    }
  });
});

describe("OMP execution errors", () => {
  it("keeps the network cause in a thrown failure", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("getaddrinfo ENOTFOUND example.invalid"),
        });
      }),
    );
    const recall = tool(ompTools(), "memory_recall") as RegisteredTool & {
      execute(...args: unknown[]): Promise<unknown>;
    };

    await expect(
      recall.execute(
        "call-1",
        { namespace: "test", profile: "agent", query: "synthetic" },
        new AbortController().signal,
        undefined,
      ),
    ).rejects.toThrow("fetch failed: getaddrinfo ENOTFOUND example.invalid");
  });
});
