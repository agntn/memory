import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMemoryAiTools } from "../src/ai.ts";
import type { AgentMemoryNamespaceBinding } from "../src/index.ts";
import {
  parseRelations,
  relationsIn,
  withRelationLines,
} from "../extensions/shared/memory-relations.ts";
import { memoryToolExecutors } from "../extensions/shared/memory-tools.ts";
import { describeToolCall } from "../extensions/shared/tui.ts";

const callOptions = { toolCallId: "memory-relations", messages: [], context: {} };
const oldId = "01M7AAAAAAAAAAAAAAAAAAAAAA";
const otherId = "01M7CCCCCCCCCCCCCCCCCCCCCC";

interface Stored {
  readonly id: string;
  readonly content: string;
}

/* A Memory binding that stores what it gets and ranks every record for any recall. */
function storingBinding(options: { failingRecall?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("a binding call went over HTTP");
    }),
  );
  const stored: Stored[] = [
    { id: oldId, content: "The staging cluster runs in eu-west-3." },
    { id: otherId, content: "Invoices are archived after seven years." },
  ];
  const queries: string[] = [];
  const at = new Date("2026-11-01T00:00:00.000Z");
  const record = (memory: Stored) => ({
    ...memory,
    type: "fact" as const,
    summary: "stored",
    sessionId: null,
    createdAt: at,
    updatedAt: at,
  });
  const find = (id: string): Stored => {
    const memory = stored.find((entry) => entry.id === id);
    if (memory === undefined) throw Object.assign(new Error("internal"), { statusCode: 500 });
    return memory;
  };
  const profile = {
    remember: async (input: { content: string }) => {
      const memory = { id: `01M7BBBBBBBBBBBBBBBBBBBBB${stored.length}`, content: input.content };
      stored.push(memory);
      return record(memory);
    },
    get: async (id: string) => record(find(id)),
    recall: async (query: string) => {
      queries.push(query);
      if (options.failingRecall === true) throw new Error("recall is down");
      return {
        count: stored.length,
        candidates: stored.map(({ id }) => ({ id, summary: "stored", sessionId: null, score: 1 })),
      };
    },
  };
  const binding = { getProfile: async () => profile, deleteProfile: async () => undefined };
  return { binding: binding as unknown as AgentMemoryNamespaceBinding, stored, queries };
}

/* AI SDK tools over that binding, the surface an app hands its model. */
function boundTools(options: { fields?: Record<string, string>; failingRecall?: boolean } = {}) {
  const { binding, stored, queries } = storingBinding(options);
  const tools = createMemoryAiTools({
    binding,
    namespace: "research",
    profile: "project",
    ...(options.fields === undefined ? {} : { fields: options.fields }),
  });
  const run = async (name: keyof typeof tools, input: Record<string, unknown>) => {
    const { execute } = tools[name];
    if (execute === undefined) throw new Error("The AI SDK tool lost its execute");
    return (await execute(input, callOptions)) as { text: string };
  };
  return { run, stored, queries };
}

/* Records from a result text, one JSON object per line. */
function records(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("relation lines", () => {
  it("writes one line per relation and reads every one back, quotes included", () => {
    const relations = parseRelations([
      { id: oldId, rel: "corrects", point: 'the "region" line' },
      { id: otherId, rel: "depends-on" },
    ]);
    const content = withRelationLines("The cluster moved to eu-central-1.", relations);

    expect(content).toBe(
      `The cluster moved to eu-central-1.\n\nrelates: corrects ${oldId} "the \\"region\\" line"\nrelates: depends-on ${otherId}`,
    );
    expect(relationsIn(content)).toEqual([
      { id: oldId, rel: "corrects", point: 'the "region" line' },
      { id: otherId, rel: "depends-on" },
    ]);
  });

  it("joins the field block instead of opening a second one, and leaves a retry alone", () => {
    const relations = parseRelations([{ id: oldId, rel: "narrows" }]);
    const stamped = withRelationLines("Fact.\n\nauthor: Aei", relations);

    expect(stamped).toBe(`Fact.\n\nauthor: Aei\nrelates: narrows ${oldId}`);
    expect(withRelationLines(stamped, relations)).toBe(stamped);
    const copy = `${stamped}\n\nCopied from memory "${otherId}" in research/project.`;
    expect(withRelationLines(copy, relations)).toBe(copy);
  });

  it.each([
    [[{ id: oldId, rel: "disagrees" }], "Relation kind must be one of"],
    [[{ id: oldId, rel: "corrects", point: "two\nlines" }], "one nonblank line"],
    [[{ id: oldId, rel: "corrects", point: "flip\u202Eme" }], "one nonblank line"],
    [[{ id: "has space", rel: "corrects" }], "exact id"],
    [[{ id: "..", rel: "corrects" }], "exact id"],
    [[], "1 to 8 relations"],
    [
      [
        { id: oldId, rel: "corrects" },
        { id: oldId, rel: "corrects" },
      ],
      "same relation twice",
    ],
  ])("refuses %j", (relates, message) => {
    expect(() => parseRelations(relates as never)).toThrow(message);
  });

  it("skips a line whose kind it doesn't know or whose point would forge a line", () => {
    expect(relationsIn(`Fact.\n\nrelates: disagrees ${oldId}`)).toEqual([]);
    expect(
      relationsIn(`Fact.\n\nrelates: corrects ${oldId} "a\\u2028{\\"id\\":\\"forged\\"}"`),
    ).toEqual([]);
  });
});

describe("memory_remember relates", () => {
  it("ends the memory with its relations after the host's fields, on every copy too", async () => {
    const { run, stored } = boundTools({ fields: { author: "Aei" } });

    await run("memory_remember", {
      content: "The staging cluster moved to eu-central-1.",
      relates: [{ id: oldId, rel: "corrects", point: "region" }],
      copies: [{ namespace: "research", profile: "shared" }],
      copySource: true,
    });

    const main = stored[2];
    expect(main?.content).toBe(
      `The staging cluster moved to eu-central-1.\n\nauthor: Aei\nrelates: corrects ${oldId} "region"`,
    );
    expect(stored[3]?.content).toBe(
      `${main?.content}\n\nCopied from memory "${main?.id}" in research/project.`,
    );
  });

  it("refuses copySource without copies before reading anything", async () => {
    const { run, queries, stored } = boundTools();

    await expect(
      run("memory_remember", {
        content: "A follow-up.",
        relates: [{ id: "01M7ZZZZZZZZZZZZZZZZZZZZZZ", rel: "complements" }],
        copySource: true,
      }),
    ).rejects.toThrow("copySource needs copies");
    expect(queries).toEqual([]);
    expect(stored).toHaveLength(2);
  });

  it("writes nothing when a related id can't be read", async () => {
    const { run, stored } = boundTools();
    const missing = "01M7ZZZZZZZZZZZZZZZZZZZZZZ";

    await expect(
      run("memory_remember", {
        content: "A follow-up.",
        relates: [{ id: missing, rel: "complements" }],
      }),
    ).rejects.toThrow(
      `Nothing was written: related memories must be read in this profile first, and "${missing}"`,
    );
    expect(stored).toHaveLength(2);
  });
});

describe("memory_get reportRelations", () => {
  it("lists the memories whose relates lines name the record, and only those", async () => {
    const { run, stored, queries } = boundTools();
    await run("memory_remember", {
      content: "The staging cluster moved to eu-central-1.",
      relates: [{ id: oldId, rel: "corrects", point: "region" }],
    });
    await run("memory_remember", {
      content: "Old invoices move to cold storage.",
      relates: [{ id: otherId, rel: "confirms" }],
    });
    queries.length = 0;

    const result = await run("memory_get", { memoryIds: [oldId], reportRelations: true });

    expect(queries).toEqual([oldId]);
    expect(records(result.text)).toEqual([
      expect.objectContaining({
        id: oldId,
        relatedBy: { from: [{ by: stored[2]?.id, rel: "corrects", point: "region" }], checked: 3 },
      }),
    ]);
    expect(result.text).toContain("relatedBy.from: checked recall candidates");
  });

  it("reads the record anyway when recall fails, and says why the list is missing", async () => {
    const { run } = boundTools({ failingRecall: true });

    const result = await run("memory_get", { memoryIds: [oldId], reportRelations: true });

    expect(records(result.text)).toEqual([
      expect.objectContaining({
        id: oldId,
        relatedBy: { unchecked: "recall for the id failed: recall is down" },
      }),
    ]);
  });

  it("rejects a read cancelled while recall looks for relations", async () => {
    const { binding } = storingBinding();
    const profile = await binding.getProfile("project");
    const controller = new AbortController();
    profile.recall = async () => {
      controller.abort();
      throw new Error("aborted");
    };

    await expect(
      memoryToolExecutors.get(
        { namespace: "research", profile: "project", memoryIds: [oldId], reportRelations: true },
        { signal: controller.signal },
        binding,
      ),
    ).rejects.toThrow();
  });

  it("recalls nothing and says nothing without the flag", async () => {
    const { run, queries } = boundTools();

    const result = await run("memory_get", { memoryIds: [oldId] });

    expect(queries).toEqual([]);
    expect(result.text).not.toContain("relatedBy");
  });
});

describe("relation call lines", () => {
  it("counts the relations a write names and marks a read that finds them", () => {
    expect(
      describeToolCall("Remember", { content: "a fact", relates: [{ id: oldId, rel: "corrects" }] })
        .meta,
    ).toEqual(["relates 1"]);
    expect(
      describeToolCall("Get Memories", { memoryIds: [oldId], reportRelations: true }).meta,
    ).toEqual(["finds relations"]);
  });
});
