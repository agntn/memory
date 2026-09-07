import { describe, expect, it, vi } from "vitest";
import {
  CloudflareMemoryProvider,
  CloudflareNamespaceClient,
  MemoryAuthError,
  MemoryError,
  MemoryHttpError,
  MemoryInputError,
  MemoryNotFoundError,
  MemoryRateLimitError,
  MemoryProfile,
  cloudflareMemoryLimits,
  create,
  has,
  providers,
  registerAll,
  type AgentMemoryNamespaceBinding,
  type AgentMemoryProfileBinding,
  type Memory,
} from "../src/index.ts";

const memory: Memory = {
  id: "memory-1",
  type: "instruction",
  summary: "Concise answers",
  content: "The user prefers concise answers.",
  sessionId: "session-1",
  createdAt: new Date("2026-04-21T00:00:00.000Z"),
  updatedAt: new Date("2026-04-21T00:00:00.000Z"),
};

function jsonResponse(result: unknown, init: ResponseInit = {}): Response {
  return Response.json({ result, success: (init.status ?? 200) < 400, errors: [] }, init);
}

describe("CloudflareMemoryProvider binding transport", () => {
  it("forwards profile operations to the Worker binding", async () => {
    const profile = {
      ingest: vi.fn(async () => undefined),
      remember: vi.fn(async () => memory),
      recall: vi.fn(async () => ({ count: 1, answer: memory.summary, candidates: [] })),
      list: vi.fn(async () => ({ memories: [] })),
      get: vi.fn(async () => memory),
      delete: vi.fn(async () => memory),
      deleteSession: vi.fn(async () => undefined),
      getSummary: vi.fn(async () => ({ summary: memory.summary })),
    } satisfies AgentMemoryProfileBinding;
    const binding = {
      getProfile: vi.fn(async () => profile),
      deleteProfile: vi.fn(async () => undefined),
    } satisfies AgentMemoryNamespaceBinding;
    const provider = new CloudflareMemoryProvider({ binding });
    const selected = await provider.getProfile("user-1");

    await expect(selected.remember({ content: memory.content })).resolves.toEqual(memory);
    expect(binding.getProfile).toHaveBeenCalledWith("user-1");
    expect(profile.remember).toHaveBeenCalledWith({ content: memory.content });

    await provider.deleteProfile("user-1");
    expect(binding.deleteProfile).toHaveBeenCalledWith("user-1");
  });
});

describe("CloudflareMemoryProvider HTTP transport", () => {
  it("maps domain operations to the documented HTTP API", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "DELETE") return jsonResponse(memory);
      return jsonResponse(memory);
    });
    const provider = new CloudflareMemoryProvider({
      accountId: "account/id",
      namespace: "support-agent",
      apiToken: "secret-token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user-name");

    await expect(
      profile.remember({ content: memory.content, sessionId: "session-1" }),
    ).resolves.toEqual(memory);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account%2Fid/agent-memory/namespaces/support-agent/profiles/user-name/remember",
      expect.objectContaining({ method: "POST" }),
    );
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("refuses identifiers that would leave their path segment", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(memory));
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    for (const identifier of ["..", "."]) {
      await expect(profile.get(identifier)).rejects.toBeInstanceOf(MemoryInputError);
      await expect(profile.delete(identifier)).rejects.toBeInstanceOf(MemoryInputError);
      await expect(profile.deleteSession(identifier)).rejects.toBeInstanceOf(MemoryInputError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a page size the service answers with 400", async () => {
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: vi.fn<typeof fetch>(async () => jsonResponse([])),
    });
    const profile = await provider.getProfile("user");

    await expect(profile.list({ limit: cloudflareMemoryLimits.httpListLimit })).resolves.toEqual({
      memories: [],
    });
    await expect(
      profile.list({ limit: cloudflareMemoryLimits.httpListLimit + 1 }),
    ).rejects.toBeInstanceOf(MemoryInputError);
  });

  it("rejects profile names the service answers with 400", async () => {
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: vi.fn<typeof fetch>(),
    });

    for (const name of ["User", "with space", "under_score", "-leading", "trailing-"]) {
      await expect(provider.getProfile(name)).rejects.toBeInstanceOf(MemoryInputError);
      await expect(provider.deleteProfile(name)).rejects.toBeInstanceOf(MemoryInputError);
    }
    await expect(provider.getProfile("ok-name-1")).resolves.toBeDefined();
  });

  it("maps list filters and Cloudflare cursors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        result: [{ ...memory, content: undefined }],
        success: true,
        errors: [],
        result_info: { cursor: "next" },
      }),
    );
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    await expect(
      profile.list({ limit: 50, cursor: "cursor", sessionId: "session", type: "fact" }),
    ).resolves.toMatchObject({ cursor: "next" });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account/agent-memory/namespaces/namespace/profiles/user/memories?per_page=50&cursor=cursor&session_id=session&type=fact",
    );
  });

  it("returns typed authentication errors without exposing the token", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          result: null,
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        },
        { status: 401 },
      ),
    );
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "do-not-leak",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    const error = await profile.get("missing").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MemoryAuthError);
    expect(String(error)).not.toContain("do-not-leak");
  });

  describe.each(["<html>Service unavailable</html>", "", "null", '{"errors":[]}'])(
    "HTTP errors with body %j",
    (body) => {
      it.each([
        [401, MemoryAuthError],
        [403, MemoryAuthError],
        [404, MemoryNotFoundError],
        [429, MemoryRateLimitError],
        [502, MemoryHttpError],
      ] as const)("classifies status %i for profiles and namespaces", async (status, ErrorType) => {
        const options = {
          accountId: "account",
          namespace: "namespace",
          apiToken: "token",
          fetch: vi.fn<typeof fetch>(async () => new Response(body, { status })),
        };
        const profile = await new CloudflareMemoryProvider(options).getProfile("user");
        const namespaces = new CloudflareNamespaceClient(options);

        for (const operation of [() => profile.get("memory-1"), () => namespaces.list()]) {
          const error = await operation().catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(ErrorType);
          expect(error).toMatchObject({
            provider: "cloudflare",
            statusCode: status,
            message: `Cloudflare Agent Memory request failed (${status})`,
          });
        }
      });
    },
  );

  it.each([
    ["not JSON", "Cloudflare Agent Memory returned invalid JSON (200)"],
    ["null", "Cloudflare Agent Memory returned an invalid response envelope"],
    ['{"result":[]}', "Cloudflare Agent Memory returned an invalid response envelope"],
  ])("still rejects malformed success body %j", async (body, message) => {
    const namespaces = new CloudflareNamespaceClient({
      accountId: "account",
      apiToken: "token",
      fetch: vi.fn<typeof fetch>(async () => new Response(body)),
    });

    await expect(namespaces.list()).rejects.toMatchObject({
      name: "MemoryHttpError",
      statusCode: 200,
      message,
    });
  });

  it.each([200, 401])("keeps API error messages with HTTP %i", async (status) => {
    const namespaces = new CloudflareNamespaceClient({
      accountId: "account",
      apiToken: "token",
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json(
          { success: false, errors: [{ message: "First error" }, { message: "Second error" }] },
          { status },
        ),
      ),
    });

    await expect(namespaces.list()).rejects.toMatchObject({
      name: status === 401 ? "MemoryAuthError" : "MemoryHttpError",
      statusCode: status,
      message: "First error; Second error",
    });
  });

  it("preserves a body read cancellation instead of reporting a rate limit", async () => {
    const cause = new DOMException("Body read cancelled", "AbortError");
    const namespaces = new CloudflareNamespaceClient({
      accountId: "account",
      apiToken: "token",
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(cause);
              },
            }),
            { status: 429 },
          ),
      ),
    });

    const error = await namespaces.list().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MemoryHttpError);
    expect(error).not.toBeInstanceOf(MemoryRateLimitError);
    expect(error).toHaveProperty("cause", cause);
  });

  it("rejects malformed provider configuration with a domain error", () => {
    expect(() => {
      Reflect.construct(CloudflareMemoryProvider, [null]);
    }).toThrow(MemoryInputError);
  });

  it("bounds ingest before consuming or sending an oversized conversation", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");
    const messages = Array.from({ length: 501 }, () => ({ role: "user" as const, content: "x" }));

    await expect(profile.ingest(messages)).rejects.toBeInstanceOf(MemoryInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a missing session ID before calling either transport", async () => {
    const bindingProfile = {
      ingest: vi.fn(),
      remember: vi.fn(),
      recall: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      deleteSession: vi.fn(),
      getSummary: vi.fn(),
    } as unknown as AgentMemoryProfileBinding;
    const binding = {
      getProfile: vi.fn(async () => bindingProfile),
      deleteProfile: vi.fn(),
    } as unknown as AgentMemoryNamespaceBinding;
    const bindingProvider = new CloudflareMemoryProvider({ binding });
    const selectedBindingProfile = await bindingProvider.getProfile("user");

    expect(() => {
      Reflect.apply(selectedBindingProfile.deleteSession, selectedBindingProfile, [undefined]);
    }).toThrow(MemoryInputError);
    expect(bindingProfile.deleteSession).not.toHaveBeenCalled();

    const fetcher = vi.fn<typeof fetch>();
    const httpProvider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const selectedHttpProfile = await httpProvider.getProfile("user");

    await expect(
      Reflect.apply(selectedHttpProfile.deleteSession, selectedHttpProfile, [undefined]),
    ).rejects.toBeInstanceOf(MemoryInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid recall tuning before calling either transport", async () => {
    const bindingProfile = {
      ingest: vi.fn(),
      remember: vi.fn(),
      recall: vi.fn(async () => ({ count: 0, candidates: [] })),
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      deleteSession: vi.fn(),
      getSummary: vi.fn(),
    } as unknown as AgentMemoryProfileBinding;
    const binding = {
      getProfile: vi.fn(async () => bindingProfile),
      deleteProfile: vi.fn(),
    } as unknown as AgentMemoryNamespaceBinding;
    const bindingProvider = new CloudflareMemoryProvider({ binding });
    const selectedBindingProfile = await bindingProvider.getProfile("user");
    const invalidOptions = [{ thinkingLevel: "extreme" }, { responseLength: "verbose" }];

    for (const options of invalidOptions) {
      expect(() => {
        Reflect.apply(selectedBindingProfile.recall, selectedBindingProfile, ["question", options]);
      }).toThrow(MemoryInputError);
    }
    expect(bindingProfile.recall).not.toHaveBeenCalled();

    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ count: 0, candidates: [] }));
    const httpProvider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const selectedHttpProfile = await httpProvider.getProfile("user");

    for (const options of invalidOptions) {
      await expect(
        Reflect.apply(selectedHttpProfile.recall, selectedHttpProfile, ["question", options]),
      ).rejects.toBeInstanceOf(MemoryInputError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes network failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network down");
    });
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    await expect(profile.recall("question")).rejects.toBeInstanceOf(MemoryError);
  });

  it("keeps the candidates when the service skips the synthesized answer", async () => {
    const candidate = { id: memory.id, summary: memory.summary, sessionId: null, score: 0.4 };
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ count: 1, candidates: [candidate] }),
    );
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    await expect(profile.recall("what does the user prefer")).resolves.toEqual({
      count: 1,
      candidates: [candidate],
    });
  });

  it("treats an empty object as the empty result a deletion returns", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    await expect(profile.deleteSession("session-1")).resolves.toBeUndefined();
  });

  it("still rejects a body where an empty result belongs", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse("deleted"));
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    await expect(profile.deleteSession("session-1")).rejects.toBeInstanceOf(MemoryHttpError);
  });

  it("rejects malformed Cloudflare response bodies with a typed HTTP error", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user");

    await expect(profile.recall("question")).rejects.toBeInstanceOf(MemoryHttpError);
  });
});

describe("CloudflareNamespaceClient", () => {
  it("lists, gets, creates, and deletes namespaces through the account API", async () => {
    const namespace = {
      id: "namespace-id",
      name: "test-namespace",
      created_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "DELETE") return jsonResponse(null);
      if (init?.method === "POST") return jsonResponse(namespace, { status: 201 });
      if (String(input).endsWith("/namespaces/test-namespace")) return jsonResponse(namespace);
      return Response.json({
        result: [namespace],
        success: true,
        errors: [],
        result_info: { cursor: "next" },
      });
    });
    const client = new CloudflareNamespaceClient({
      accountId: "account/id",
      apiToken: "token",
      fetch: fetcher,
    });

    await expect(
      client.list({ limit: 20, order: "name", direction: "asc", cursor: "cursor" }),
    ).resolves.toMatchObject({
      namespaces: [{ id: "namespace-id", name: "test-namespace" }],
      cursor: "next",
    });
    await expect(client.get("test-namespace")).resolves.toEqual({
      id: "namespace-id",
      name: "test-namespace",
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
      updatedAt: new Date("2026-08-17T00:00:00.000Z"),
    });
    await expect(client.create("test-namespace")).resolves.toMatchObject({
      id: "namespace-id",
      name: "test-namespace",
    });
    await expect(client.delete("test-namespace")).resolves.toBeUndefined();

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account%2Fid/agent-memory/namespaces?per_page=20&cursor=cursor&order=name&direction=asc",
      "https://api.cloudflare.com/client/v4/accounts/account%2Fid/agent-memory/namespaces/test-namespace",
      "https://api.cloudflare.com/client/v4/accounts/account%2Fid/agent-memory/namespaces",
      "https://api.cloudflare.com/client/v4/accounts/account%2Fid/agent-memory/namespaces/test-namespace",
    ]);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBeUndefined();
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe('{"name":"test-namespace"}');
  });

  it("pages namespaces up to the cap the namespaces endpoint publishes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse([]));
    const client = new CloudflareNamespaceClient({
      accountId: "account",
      apiToken: "token",
      fetch: fetcher,
    });

    expect(cloudflareMemoryLimits.namespaceListLimit).toBeGreaterThan(
      cloudflareMemoryLimits.httpListLimit,
    );
    await expect(
      client.list({ limit: cloudflareMemoryLimits.httpListLimit + 1 }),
    ).resolves.toMatchObject({ namespaces: [] });
    await expect(
      client.list({ limit: cloudflareMemoryLimits.namespaceListLimit }),
    ).resolves.toMatchObject({ namespaces: [] });
    await expect(
      client.list({ limit: cloudflareMemoryLimits.namespaceListLimit + 1 }),
    ).rejects.toBeInstanceOf(MemoryInputError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects namespace names that Cloudflare does not accept", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new CloudflareNamespaceClient({
      accountId: "account",
      apiToken: "token",
      fetch: fetcher,
    });

    await expect(client.create("Invalid Namespace")).rejects.toBeInstanceOf(MemoryInputError);
    await expect(client.get("Invalid Namespace")).rejects.toBeInstanceOf(MemoryInputError);
    await expect(client.listProfiles("Invalid Namespace")).rejects.toBeInstanceOf(MemoryInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lists the profiles a namespace holds, one page at a time", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        result: [{ name: "agent", createdAt: "2026-08-17T18:10:09.388Z" }],
        success: true,
        errors: [],
        result_info: { count: 1, cursor: "next", per_page: 20 },
      }),
    );
    const client = new CloudflareNamespaceClient({
      accountId: "account/id",
      apiToken: "token",
      fetch: fetcher,
    });

    await expect(
      client.listProfiles("support-agent", { limit: 20, cursor: "cursor" }),
    ).resolves.toEqual({
      profiles: [{ name: "agent", createdAt: new Date("2026-08-17T18:10:09.388Z") }],
      cursor: "next",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account%2Fid/agent-memory/namespaces/support-agent/profiles?per_page=20&cursor=cursor",
    );
  });

  it("pages profiles up to the cap the profiles endpoint publishes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse([]));
    const client = new CloudflareNamespaceClient({
      accountId: "account",
      apiToken: "token",
      fetch: fetcher,
    });

    await expect(
      client.listProfiles("namespace", { limit: cloudflareMemoryLimits.profileListLimit }),
    ).resolves.toEqual({ profiles: [] });
    await expect(
      client.listProfiles("namespace", { limit: cloudflareMemoryLimits.profileListLimit + 1 }),
    ).rejects.toBeInstanceOf(MemoryInputError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("CloudflareMemoryProvider profile listing", () => {
  const profilePage = (names: string[], cursor?: string) =>
    Response.json({
      result: names.map((name) => ({ name, createdAt: "2026-08-17T18:10:09.388Z" })),
      success: true,
      errors: [],
      result_info: { count: names.length, cursor: cursor ?? null, per_page: 500 },
    });

  it("enumerates every profile name of its namespace over HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("cursor=")
        ? profilePage(["default"])
        : profilePage(["aei", "agent"], "p2"),
    );
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "support-agent",
      apiToken: "token",
      fetch: fetcher,
    });

    expect(provider.capabilities.listProfiles).toBe(true);
    await expect(provider.listProfiles?.()).resolves.toEqual(["aei", "agent", "default"]);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account/agent-memory/namespaces/support-agent/profiles?per_page=500",
      "https://api.cloudflare.com/client/v4/accounts/account/agent-memory/namespaces/support-agent/profiles?per_page=500&cursor=p2",
    ]);
  });

  it("stops a listing whose page repeats its own cursor", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => profilePage(["aei"], "same"));
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "support-agent",
      apiToken: "token",
      fetch: fetcher,
    });

    await expect(provider.listProfiles?.()).rejects.toBeInstanceOf(MemoryHttpError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("leaves the listing absent on a binding, which has no such call", async () => {
    const provider = new CloudflareMemoryProvider({
      binding: { getProfile: vi.fn(), deleteProfile: vi.fn() },
    });

    expect(provider.capabilities.listProfiles).toBe(false);
    expect(provider.listProfiles).toBeUndefined();
    expect("listProfiles" in provider).toBe(false);
  });
});
describe("abstract capability contract", () => {
  it("keeps unsupported optional operations absent at runtime", () => {
    class RecallOnlyProfile extends MemoryProfile {}

    const profile = new RecallOnlyProfile();
    expect(profile.recall).toBeUndefined();
    expect(profile.delete).toBeUndefined();
  });
});

describe("CloudflareMemoryProvider cancellation", () => {
  it("hands the signal to fetch and keeps it out of the request body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ count: 0, answer: memory.summary, candidates: [] }),
    );
    const provider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "support-agent",
      apiToken: "token",
      fetch: fetcher,
    });
    const profile = await provider.getProfile("user-1");
    const { signal } = new AbortController();

    await profile.recall("what does the user prefer", {
      signal,
      thinkingLevel: "high",
      responseLength: "short",
    });

    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "what does the user prefer",
      thinkingLevel: "high",
      responseLength: "short",
    });
  });

  it("refuses a binding call the caller already aborted", async () => {
    const profile = {
      ingest: vi.fn(async () => undefined),
      remember: vi.fn(async () => memory),
      recall: vi.fn(async () => ({ count: 0, answer: "", candidates: [] })),
      list: vi.fn(async () => ({ memories: [] })),
      get: vi.fn(async () => memory),
      delete: vi.fn(async () => memory),
      deleteSession: vi.fn(async () => undefined),
      getSummary: vi.fn(async () => ({ summary: memory.summary })),
    } satisfies AgentMemoryProfileBinding;
    const provider = new CloudflareMemoryProvider({
      binding: { getProfile: async () => profile, deleteProfile: async () => undefined },
    });
    const selected = await provider.getProfile("user-1");
    const controller = new AbortController();
    controller.abort();

    await expect(selected.list({ signal: controller.signal })).rejects.toThrow();
    expect(profile.list).not.toHaveBeenCalled();
  });
});

describe("provider registry", () => {
  it("registers Cloudflare explicitly", () => {
    registerAll();
    expect(has("cloudflare")).toBe(true);
    expect(providers()).toContain("cloudflare");
    expect(
      create("cloudflare", {
        binding: {
          getProfile: vi.fn(),
          deleteProfile: vi.fn(),
        },
      }),
    ).toBeInstanceOf(CloudflareMemoryProvider);
  });
});
