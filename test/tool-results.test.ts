import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryToolExecutors } from "../packages/shared/memory-tools.ts";

interface StubResponse {
  result?: unknown;
  resultInfo?: Record<string, unknown>;
  /** Answer with Cloudflare's failed envelope and this status instead of a success result. */
  failure?: { status: number; message: string };
}

/**
 * Answer Cloudflare calls with canned payloads and record the URLs.
 *
 * `response` may be a single payload or a function that picks one per URL, which
 * the cascade deletes need because they read the profile before deleting.
 */
function stubCloudflare(response: StubResponse | ((url: string) => StubResponse)): string[] {
  const urls: string[] = [];
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const payload = typeof response === "function" ? response(url) : response;
      if (payload.failure !== undefined) {
        return Response.json(
          { success: false, errors: [{ message: payload.failure.message }] },
          { status: payload.failure.status },
        );
      }
      return Response.json({
        success: true,
        result: payload.result,
        ...(payload.resultInfo === undefined ? {} : { result_info: payload.resultInfo }),
      });
    }),
  );
  return urls;
}

function memoryEntry(id: string, sessionId: string | null): Record<string, unknown> {
  return {
    id,
    type: "fact",
    summary: `summary ${id}`,
    sessionId,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("recall result", () => {
  it("reports the candidate memories behind the answer", async () => {
    stubCloudflare({
      result: {
        count: 2,
        answer: "Oritwoen builds with pnpm and obuild.",
        candidates: [
          { id: "mem-1", summary: "Uses pnpm", sessionId: "s-1", score: 0.82 },
          { id: "mem-2", summary: "Uses obuild", sessionId: null, score: 0.41 },
        ],
      },
    });

    const result = await memoryToolExecutors.recall({
      namespace: "recall-candidates",
      profile: "agent",
      query: "build tooling",
    });

    const lines = textOf(result).split("\n");
    expect(lines[0]).toBe("Recall from recall-candidates/agent:");
    expect(lines[2]).toBe("Oritwoen builds with pnpm and obuild.");
    expect(textOf(result)).toContain("Candidates (2), one JSON object per line:");
    const candidates = lines.slice(-2).map((line) => JSON.parse(line));
    expect(candidates).toEqual([
      {
        id: "mem-1",
        summary: "Uses pnpm",
        sessionId: "s-1",
        score: 0.82,
        namespace: "recall-candidates",
        profile: "agent",
      },
      {
        id: "mem-2",
        summary: "Uses obuild",
        sessionId: null,
        score: 0.41,
        namespace: "recall-candidates",
        profile: "agent",
      },
    ]);
  });

  it("expands the best-scoring candidates with full content", async () => {
    const urls = stubCloudflare((url) => {
      if (url.includes("/memories/")) {
        const id = url.split("/memories/")[1] ?? "";
        return { result: { ...memoryEntry(id, null), content: `full content of ${id}` } };
      }
      return {
        result: {
          count: 3,
          answer: "Oritwoen builds with pnpm.",
          candidates: [
            { id: "mem-low", summary: "truncated", sessionId: null, score: 0.13 },
            { id: "mem-top", summary: "truncated", sessionId: null, score: 0.82 },
            { id: "mem-mid", summary: "truncated", sessionId: null, score: 0.41 },
          ],
        },
      };
    });

    const result = await memoryToolExecutors.recall({
      namespace: "recall-expand",
      profile: "agent",
      query: "build tooling",
      expand: 2,
    });

    const text = textOf(result);
    expect(text).toContain(
      "Candidates (3), one JSON object per line, full content on the 2 best-scoring:",
    );
    const candidates = text
      .split("\n")
      .slice(-3)
      .map((line) => JSON.parse(line) as { id: string; content?: string });
    expect(candidates.map((candidate) => [candidate.id, candidate.content])).toEqual([
      ["mem-low", undefined],
      ["mem-top", "full content of mem-top"],
      ["mem-mid", "full content of mem-mid"],
    ]);
    expect(urls.filter((url) => url.includes("/memories/"))).toHaveLength(2);
  });

  it("rejects an out-of-range expand before calling the service", async () => {
    const urls = stubCloudflare({ result: { count: 0, answer: "", candidates: [] } });

    for (const expand of [0, 31]) {
      await expect(
        memoryToolExecutors.recall({
          namespace: "recall-expand-guard",
          profile: "agent",
          query: "build tooling",
          expand,
        }),
      ).rejects.toThrow("Expand must be an integer between 1 and 30");
    }
    expect(urls).toHaveLength(0);
  });

  it("keeps the recall answer when an expanded read fails", async () => {
    stubCloudflare((url) => {
      if (url.includes("/memories/")) throw new Error("record unavailable");
      return {
        result: {
          count: 1,
          answer: "Oritwoen builds with pnpm.",
          candidates: [{ id: "mem-gone", summary: "truncated", sessionId: null, score: 0.9 }],
        },
      };
    });

    const result = await memoryToolExecutors.recall({
      namespace: "recall-expand-fail",
      profile: "agent",
      query: "build tooling",
      expand: 5,
    });

    const text = textOf(result);
    expect(text).toContain("full content on the 1 best-scoring (null where the read failed):");
    expect(JSON.parse(text.split("\n").at(-1) ?? "{}")).toMatchObject({
      id: "mem-gone",
      content: null,
    });
  });

  it("returns the answer alone when nothing matched", async () => {
    stubCloudflare({ result: { count: 0, answer: "Nothing stored about that.", candidates: [] } });

    const result = await memoryToolExecutors.recall({
      namespace: "recall-empty",
      profile: "agent",
      query: "unknown topic",
    });

    expect(textOf(result)).toBe("Recall from recall-empty/agent:\n\nNothing stored about that.");
  });
});

describe("list result", () => {
  it("expands the first entries of the page with full content", async () => {
    const urls = stubCloudflare((url) => {
      if (url.includes("/memories/")) {
        const id = url.split("/memories/")[1] ?? "";
        return { result: { ...memoryEntry(id, null), content: `full content of ${id}` } };
      }
      return {
        result: [
          memoryEntry("mem-1", null),
          memoryEntry("mem-2", null),
          memoryEntry("mem-3", null),
        ],
      };
    });

    const result = await memoryToolExecutors.list({
      namespace: "list-expand",
      profile: "agent",
      expand: 2,
    });

    const page = JSON.parse(textOf(result)) as {
      memories: Array<{ id: string; content?: string }>;
    };
    expect(page.memories.map((memory) => [memory.id, memory.content])).toEqual([
      ["mem-1", "full content of mem-1"],
      ["mem-2", "full content of mem-2"],
      ["mem-3", undefined],
    ]);
    expect(urls.filter((url) => url.includes("/memories/"))).toHaveLength(2);
  });

  it("keeps the page when an expanded read fails", async () => {
    stubCloudflare((url) => {
      if (url.includes("/memories/")) throw new Error("record unavailable");
      return { result: [memoryEntry("mem-gone", null)] };
    });

    const result = await memoryToolExecutors.list({
      namespace: "list-expand-fail",
      profile: "agent",
      expand: 5,
    });

    const page = JSON.parse(textOf(result)) as {
      memories: Array<{ id: string; content?: string | null }>;
    };
    expect(page.memories).toHaveLength(1);
    expect(page.memories[0]).toMatchObject({ id: "mem-gone", content: null });
  });

  it("rejects an out-of-range expand before calling the service", async () => {
    const urls = stubCloudflare({ result: [] });

    for (const expand of [0, 31]) {
      await expect(
        memoryToolExecutors.list({
          namespace: "list-expand-guard",
          profile: "agent",
          expand,
        }),
      ).rejects.toThrow("Expand must be an integer between 1 and 30");
    }
    expect(urls).toHaveLength(0);
  });
});

describe("paged results", () => {
  it("marks the last page instead of omitting the cursor", async () => {
    stubCloudflare({ result: [] });

    const result = await memoryToolExecutors.list({
      namespace: "page-end",
      profile: "agent",
      limit: 10,
    });

    expect(JSON.parse(textOf(result))).toMatchObject({ cursor: null, hasMore: false });
  });

  it("passes the next cursor through", async () => {
    stubCloudflare({ result: [], resultInfo: { cursor: "next-page" } });

    const result = await memoryToolExecutors.list({
      namespace: "page-more",
      profile: "agent",
      limit: 10,
    });

    expect(JSON.parse(textOf(result))).toMatchObject({ cursor: "next-page", hasMore: true });
  });

  it("marks namespace pages the same way", async () => {
    stubCloudflare({ result: [], resultInfo: { cursor: "ns-next" } });

    const result = await memoryToolExecutors.listNamespaces({ limit: 5 });

    expect(JSON.parse(textOf(result))).toMatchObject({ cursor: "ns-next", hasMore: true });
  });
});

describe("ingest result", () => {
  it("states that extraction is asynchronous", async () => {
    stubCloudflare({ result: null });

    const result = await memoryToolExecutors.ingest({
      namespace: "ingest-async",
      profile: "agent",
      messages: [{ role: "user", content: "I deploy with pnpm." }],
      sessionId: "s-9",
    });

    const text = textOf(result);
    expect(text).toContain("ingest-async/agent");
    expect(text).toContain("session s-9");
    expect(text).toContain("asynchronously");
    expect(result.details).toMatchObject({ messageCount: 1, sessionId: "s-9" });
  });
});

describe("cascade delete results", () => {
  it("counts what a session held before deleting it", async () => {
    const urls = stubCloudflare((url) =>
      url.includes("/memories")
        ? { result: [memoryEntry("mem-1", "s-3"), memoryEntry("mem-2", "s-3")] }
        : { result: null },
    );

    const result = await memoryToolExecutors.deleteSession({
      namespace: "cascade-count",
      profile: "agent",
      sessionId: "s-3",
    });

    expect(textOf(result)).toBe("Deleted session s-3 in cascade-count/agent, holding 2 memories.");
    expect(result.details).toMatchObject({ removedMemories: 2, removedAtLeast: false });
    expect(urls[0]).toContain("session_id=s-3");
  });

  it("says plainly when a session id matched nothing", async () => {
    stubCloudflare((url) => (url.includes("/memories") ? { result: [] } : { result: null }));

    const result = await memoryToolExecutors.deleteSession({
      namespace: "cascade-empty",
      profile: "agent",
      sessionId: "typo",
    });

    expect(textOf(result)).toContain("No memory in cascade-empty/agent carried session typo");
    expect(result.details).toMatchObject({ removedMemories: 0 });
  });

  it("counts a profile before deleting it", async () => {
    stubCloudflare((url) =>
      url.includes("/memories") ? { result: [memoryEntry("mem-1", null)] } : { result: null },
    );

    const result = await memoryToolExecutors.deleteProfile({
      namespace: "cascade-profile",
      profile: "agent",
    });

    expect(textOf(result)).toBe("Deleted profile cascade-profile/agent, holding 1 memory.");
  });
});

describe("ingest payload", () => {
  it("forwards only the modelled message fields", async () => {
    const bodies: string[] = [];
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Response.json({ success: true, result: null });
      }),
    );

    await memoryToolExecutors.ingest({
      namespace: "extra-fields",
      profile: "agent",
      messages: [
        { role: "user", content: "hi", injected: "smuggled" } as unknown as {
          role: "user";
          content: string;
        },
      ],
    });

    expect(bodies[0]).not.toContain("smuggled");
    expect(JSON.parse(bodies[0] ?? "{}").messages[0]).toEqual({ role: "user", content: "hi" });
  });
});

describe("delete resilience", () => {
  it("still deletes the session when the pre-read count fails", async () => {
    stubCloudflare((url) => {
      if (!url.includes("/memories")) return { result: null };
      throw new Error("list unavailable");
    });

    const result = await memoryToolExecutors.deleteSession({
      namespace: "count-fails",
      profile: "agent",
      sessionId: "s-1",
    });

    expect(textOf(result)).toBe(
      "Deleted session s-1 in count-fails/agent, holding an unknown number of memories.",
    );
    expect(result.details).toMatchObject({ removedMemories: null });
  });

  it("keeps an authentication failure free of not-found guidance", async () => {
    stubCloudflare({ failure: { status: 401, message: "Invalid token" } });

    const error = await memoryToolExecutors
      .get({ namespace: "auth-fail", profile: "agent", memoryIds: ["mem-1"] })
      .catch((cause: unknown) => cause);

    expect((error as Error).message).toBe("Invalid token");
  });

  it("explains that an unknown id fails the same way as a server error", async () => {
    stubCloudflare({ failure: { status: 500, message: "internal" } });

    const error = await memoryToolExecutors
      .get({ namespace: "server-fail", profile: "agent", memoryIds: ["mem-1"] })
      .catch((cause: unknown) => cause);

    expect((error as Error).message).toContain("an id that does not exist in server-fail/agent");
  });
});

describe("get result", () => {
  it("reads several memories in one call, keeping request order", async () => {
    const urls = stubCloudflare((url) => {
      const id = url.split("/").at(-1) ?? "";
      return { result: { ...memoryEntry(id, null), content: `content ${id}` } };
    });

    const result = await memoryToolExecutors.get({
      namespace: "get-many",
      profile: "agent",
      memoryIds: ["mem-2", "mem-1"],
    });

    const memories = JSON.parse(textOf(result)) as Array<{ id: string; content: string }>;
    expect(memories.map((memory) => memory.id)).toEqual(["mem-2", "mem-1"]);
    expect(memories[0]?.content).toBe("content mem-2");
    expect(urls).toHaveLength(2);
  });

  it("keeps one failed read from hiding the rest", async () => {
    stubCloudflare((url) =>
      url.endsWith("/mem-missing")
        ? { failure: { status: 500, message: "internal" } }
        : { result: { ...memoryEntry("mem-1", null), content: "content mem-1" } },
    );

    const result = await memoryToolExecutors.get({
      namespace: "get-partial",
      profile: "agent",
      memoryIds: ["mem-1", "mem-missing"],
    });

    const [header, ...body] = textOf(result).split("\n");
    expect(header).toBe("Read 1 of 2 memories; error entries for: mem-missing.");
    const memories = JSON.parse(body.join("\n")) as Array<Record<string, unknown>>;
    expect(memories[0]).toMatchObject({ id: "mem-1", content: "content mem-1" });
    expect(memories[1]).toEqual({
      id: "mem-missing",
      error:
        "internal (an id that does not exist in get-partial/agent fails this way too; confirm it with memory_list)",
    });
  });

  it("reads duplicate ids once", async () => {
    const urls = stubCloudflare((url) => {
      const id = url.split("/").at(-1) ?? "";
      return { result: { ...memoryEntry(id, null), content: `content ${id}` } };
    });

    const result = await memoryToolExecutors.get({
      namespace: "get-dedup",
      profile: "agent",
      memoryIds: ["mem-1", "mem-1", "mem-2"],
    });

    const memories = JSON.parse(textOf(result)) as Array<{ id: string }>;
    expect(memories.map((memory) => memory.id)).toEqual(["mem-1", "mem-2"]);
    expect(urls).toHaveLength(2);
  });

  it("names every id when all reads fail", async () => {
    stubCloudflare({ failure: { status: 500, message: "internal" } });

    const error = await memoryToolExecutors
      .get({ namespace: "get-all-fail", profile: "agent", memoryIds: ["mem-1", "mem-2"] })
      .catch((cause: unknown) => cause);

    const message = (error as Error).message;
    expect(message).toContain("Every read in get-all-fail/agent failed:");
    expect(message).toContain("mem-1: internal");
    expect(message).toContain("mem-2: internal");
  });

  it("rejects an id list beyond the published read cap", async () => {
    await expect(
      memoryToolExecutors.get({
        namespace: "get-cap",
        profile: "agent",
        memoryIds: Array.from({ length: 31 }, (_value, index) => `mem-${index}`),
      }),
    ).rejects.toThrow("Memory ids must be a list of 1 to 30 identifiers");
  });
});

describe("summary result", () => {
  it("states which profile and session it covers", async () => {
    stubCloudflare({ result: { summary: "## Key Facts\n- builds with obuild" } });

    const result = await memoryToolExecutors.summary({
      namespace: "summary-scope",
      profile: "agent",
      sessionId: "s-1",
    });

    expect(textOf(result)).toBe(
      "Summary of summary-scope/agent, session s-1:\n\n## Key Facts\n- builds with obuild",
    );
  });
});
