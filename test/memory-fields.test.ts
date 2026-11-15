import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMemoryAiTools } from "../src/ai.ts";
import type { AgentMemoryNamespaceBinding } from "../src/index.ts";
import {
  callMemoryFields,
  configuredMemoryFields,
  hostMemoryFields,
  parseMemoryFields,
  withRepositoryField,
} from "../extensions/shared/memory-fields.ts";
import { detectedMemoryHarness } from "../extensions/shared/memory-scope.ts";

const callOptions = { toolCallId: "memory-fields", messages: [], context: {} };
const oldId = "01M7AAAAAAAAAAAAAAAAAAAAAA";

interface Stored {
  readonly id: string;
  readonly content: string;
}

/* A one-profile Memory binding that stores what it is given, so a read sees the written bytes. */
function storingBinding(): { binding: AgentMemoryNamespaceBinding; stored: Stored[] } {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("a binding call went over HTTP");
    }),
  );
  const stored: Stored[] = [{ id: oldId, content: "Old note." }];
  const record = (memory: Stored) => ({
    ...memory,
    type: "fact" as const,
    summary: "stored",
    sessionId: null,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  });
  const find = (id: string): Stored => {
    const memory = stored.find((entry) => entry.id === id);
    if (memory === undefined) throw new Error(`no memory ${id}`);
    return memory;
  };
  const profile = {
    remember: async (input: { content: string }) => {
      const memory = { id: `01M7BBBBBBBBBBBBBBBBBBBBB${stored.length}`, content: input.content };
      stored.push(memory);
      return record(memory);
    },
    get: async (id: string) => record(find(id)),
    recall: async () => ({
      count: stored.length,
      candidates: stored.map(({ id }) => ({ id, summary: "stored", sessionId: null, score: 1 })),
    }),
    delete: async (id: string) => record(find(id)),
  };
  const binding = { getProfile: async () => profile, deleteProfile: async () => undefined };
  return { binding: binding as unknown as AgentMemoryNamespaceBinding, stored };
}

function boundTools(fields: Record<string, string>) {
  const { binding, stored } = storingBinding();
  const tools = createMemoryAiTools({ binding, namespace: "support", profile: "user-42", fields });
  const run = async (name: keyof typeof tools, input: Record<string, unknown>) => {
    const { execute } = tools[name];
    if (execute === undefined) throw new Error("The AI SDK tool lost its execute");
    return (await execute(input, callOptions)) as { text: string };
  };
  return { run, stored };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("memory fields", () => {
  it("ends every written memory with the host's fields, one key: value line each", async () => {
    const { run, stored } = boundTools({ platform: "web", meta_category: "account" });

    await run("memory_remember", { content: "Go to Settings and select Reset password." });

    expect(stored.at(-1)?.content).toBe(
      "Go to Settings and select Reset password.\n\nplatform: web\nmeta_category: account",
    );
  });

  it("puts the fields before the copy source line, so copies carry both", async () => {
    const { run, stored } = boundTools({ author: "Aei" });

    await run("memory_remember", {
      content: "Note.",
      copies: [{ namespace: "support", profile: "shared" }],
      copySource: true,
    });

    expect(stored[1]?.content).toBe("Note.\n\nauthor: Aei");
    expect(stored[2]?.content).toBe(
      `Note.\n\nauthor: Aei\n\nCopied from memory "${stored[1]?.id}" in support/user-42.`,
    );
  });

  it("keeps a retried copy byte for byte like the copies that landed", async () => {
    const { run, stored } = boundTools({ author: "Aei" });
    await run("memory_remember", {
      content: "Note.",
      copies: [{ namespace: "support", profile: "shared" }],
      copySource: true,
    });
    const landed = stored[2]?.content;

    await run("memory_remember", { namespace: "support", profile: "other", content: landed });

    expect(stored.at(-1)?.content).toBe(landed);
  });

  it("verifies a supersession against the stamped replacement and resumes from the bare content", async () => {
    const { run, stored } = boundTools({ author: "Aei" });
    const check = { query: "note", timeoutSeconds: 1 };

    const replaced = await run("memory_supersede", {
      oldMemoryId: oldId,
      content: "New note.",
      ...check,
    });
    const replacement = stored.at(-1);
    const resumed = await run("memory_supersession_resume", {
      oldMemoryId: oldId,
      replacementMemoryId: replacement?.id,
      content: "New note.",
      ...check,
    });

    expect(replacement?.content).toBe("New note.\n\nauthor: Aei");
    expect(replaced.text).toContain("Superseded");
    expect(resumed.text).toContain(oldId);
  });

  it.each([
    ["another host's fields", "New note.\n\nharness: pi\nauthor: Aei"],
    ["no fields from before they were set", "New note."],
  ])("resumes a replacement stored with %s", async (_label, storedContent) => {
    const { run, stored } = boundTools({ harness: "claude" });
    stored.push({ id: "01M7CCCCCCCCCCCCCCCCCCCCCC", content: storedContent });

    const resumed = await run("memory_supersession_resume", {
      oldMemoryId: oldId,
      replacementMemoryId: "01M7CCCCCCCCCCCCCCCCCCCCCC",
      content: "New note.",
      query: "note",
      timeoutSeconds: 1,
    });

    expect(resumed.text).toContain("Resumed supersession");
  });

  it("refuses to resume a replacement whose extra text is not field lines", async () => {
    const { run, stored } = boundTools({ harness: "claude" });
    stored.push({ id: "01M7CCCCCCCCCCCCCCCCCCCCCC", content: "New note.\n\nSomething else." });

    await expect(
      run("memory_supersession_resume", {
        oldMemoryId: oldId,
        replacementMemoryId: "01M7CCCCCCCCCCCCCCCCCCCCCC",
        content: "New note.",
        query: "note",
        timeoutSeconds: 1,
      }),
    ).rejects.toThrow("did not match the stored id and content");
  });

  it("leaves content that already ends with the fields alone instead of stamping it twice", async () => {
    const { run, stored } = boundTools({ author: "Aei" });

    await run("memory_remember", { content: "Note.\n\nauthor: Aei" });

    expect(stored.at(-1)?.content).toBe("Note.\n\nauthor: Aei");
  });

  it("stamps the caller's fields after the host's, on the main record and every copy", async () => {
    const { run, stored } = boundTools({ harness: "claude" });

    await run("memory_remember", {
      content: "Note.",
      fields: { author: "Aei", source: "agntn/memory#149" },
      copies: [{ namespace: "support", profile: "shared" }],
      copySource: true,
    });

    const block = "\n\nharness: claude\nauthor: Aei\nsource: agntn/memory#149";
    expect(stored[1]?.content).toBe(`Note.${block}`);
    expect(stored[2]?.content).toBe(
      `Note.${block}\n\nCopied from memory "${stored[1]?.id}" in support/user-42.`,
    );
  });

  it("keeps a retried copy with caller fields byte for byte like the copies that landed", async () => {
    const { run, stored } = boundTools({ harness: "claude" });
    await run("memory_remember", {
      content: "Note.",
      fields: { author: "Aei" },
      copies: [{ namespace: "support", profile: "shared" }],
      copySource: true,
    });
    const landed = stored[2]?.content;

    await run("memory_remember", { namespace: "support", profile: "other", content: landed });

    expect(stored.at(-1)?.content).toBe(landed);
  });

  it("stamps the caller's fields without any host fields, and supersedes with them", async () => {
    const { binding, stored } = storingBinding();
    const tools = createMemoryAiTools({ binding, namespace: "support", profile: "user-42" });

    await tools.memory_supersede.execute?.(
      {
        oldMemoryId: oldId,
        content: "New note.",
        fields: { author: "Aei" },
        query: "note",
        timeoutSeconds: 1,
      },
      callOptions,
    );

    expect(stored.at(-1)?.content).toBe("New note.\n\nauthor: Aei");
    expect(stored).toHaveLength(2);
  });

  it.each([
    [{ harness: "grok" }, "the host writes harness: claude itself, so leave harness out of fields"],
    [{ author: "Aei\nharness: forged" }, 'Memory field "author" must be one line'],
    [{ author: " " }, 'Memory field "author" must not be blank'],
  ])("refuses caller fields %j before anything is written", async (fields, message) => {
    const { run, stored } = boundTools({ harness: "claude" });

    await expect(run("memory_remember", { content: "Note.", fields })).rejects.toThrow(message);
    expect(stored).toHaveLength(1);
  });

  it("takes a caller field the host already writes with the same value", () => {
    expect(callMemoryFields({ harness: "claude" }, { harness: "claude", author: "Aei" })).toEqual({
      harness: "claude",
      author: "Aei",
    });
    expect(callMemoryFields(undefined, {})).toBeUndefined();
  });

  it("adds the repository after the host's fields unless the host names one", () => {
    expect(Object.entries(withRepositoryField({ harness: "pi" }, "agntn/memory")!)).toEqual([
      ["harness", "pi"],
      ["repository", "agntn/memory"],
    ]);
    expect(withRepositoryField(undefined, "agntn/memory")).toEqual({ repository: "agntn/memory" });
    expect(withRepositoryField({ repository: "acme/fork" }, "agntn/memory")).toEqual({
      repository: "acme/fork",
    });
    expect(withRepositoryField({ harness: "pi" }, undefined)).toEqual({ harness: "pi" });
  });

  it("refuses content the fields would push past the byte cap before anything is written", async () => {
    const { run, stored } = boundTools({ author: "Aei" });

    await expect(run("memory_remember", { content: "x".repeat(32_760) })).rejects.toThrow(
      "Memory fields add 13 bytes, taking the content to 32773 of 32768 UTF-8 bytes",
    );
    expect(stored).toHaveLength(1);
  });

  it.each([
    [{ "Autor zapisu": "Aei" }, 'Memory field key "Autor zapisu" must match'],
    [{ author: "Aei\nplatform: forged" }, 'Memory field "author" must be one line'],
    [{ author: "Aei\u2028platform: forged" }, 'Memory field "author" must be one line'],
    [{ author: "Aei\u0000" }, 'Memory field "author" must be one line'],
    [{ author: "  " }, 'Memory field "author" must not be blank'],
    [{ author: 42 }, 'Memory field "author" must be a string'],
    [["author"], "must be an object of strings"],
  ])("refuses fields %j when the tools are created", (fields, message) => {
    expect(() => parseMemoryFields(fields, "Memory fields")).toThrow(message);
    expect(() => {
      Reflect.apply(createMemoryAiTools, undefined, [{ fields }]);
    }).toThrow(message);
  });

  it("reads the fields from AGNTN_MEMORY_FIELDS as a JSON object", () => {
    vi.stubEnv("AGNTN_MEMORY_FIELDS", '{"author":" Aei ","platform":"web"}');

    expect(configuredMemoryFields()).toEqual({ author: "Aei", platform: "web" });
  });

  it.each([
    ["", undefined],
    ["{}", undefined],
    ["  ", undefined],
  ])("reads %j in AGNTN_MEMORY_FIELDS as no fields", (value, expected) => {
    vi.stubEnv("AGNTN_MEMORY_FIELDS", value);

    expect(configuredMemoryFields()).toBe(expected);
  });

  it("puts the host's harness first and lets a harness key in the variable replace it", () => {
    expect(hostMemoryFields("pi", {})).toEqual({ harness: "pi" });
    expect(hostMemoryFields(undefined, {})).toBeUndefined();
    const env = { AGNTN_MEMORY_FIELDS: '{"author":"Aei","harness":"pi-dev"}' };
    expect(Object.entries(hostMemoryFields("pi", env) ?? {})).toEqual([
      ["harness", "pi-dev"],
      ["author", "Aei"],
    ]);
  });

  it.each([
    [
      { CLAUDE_PROJECT_DIR: "/work", CLAUDE_CODE_SESSION_ID: "c-1", GROK_SESSION_ID: "g-1" },
      "claude",
    ],
    [{ CLAUDE_CODE_SESSION_ID: "c-1", GROK_SESSION_ID: "g-1" }, "grok"],
    [{ GROK_SESSION_ID: " " }, undefined],
    [{}, undefined],
  ])("names the harness behind %j as %s", (env, harness) => {
    expect(detectedMemoryHarness(env)).toBe(harness);
  });

  it("names the variable when AGNTN_MEMORY_FIELDS is not JSON", () => {
    vi.stubEnv("AGNTN_MEMORY_FIELDS", "author=Aei");

    expect(() => configuredMemoryFields()).toThrow("AGNTN_MEMORY_FIELDS must be a JSON object");
  });

  it("puts the app after the harness, and the variable still wins", () => {
    expect(hostMemoryFields({ harness: "pi", app: "openbot" }, {})).toEqual({
      harness: "pi",
      app: "openbot",
    });
    expect(
      Object.keys(
        hostMemoryFields(
          { harness: "pi", app: "openbot" },
          { AGNTN_MEMORY_FIELDS: '{"app":"bot","team":"a"}' },
        )!,
      ),
    ).toEqual(["harness", "app", "team"]);
    expect(
      hostMemoryFields({ harness: "pi", app: "openbot" }, { AGNTN_MEMORY_FIELDS: '{"app":"bot"}' })!
        .app,
    ).toBe("bot");
  });
});
