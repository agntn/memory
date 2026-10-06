import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { settle, useRetryTimers } from "./fake-timers.ts";
import {
  CloudflareMemoryProvider,
  CloudflareNamespaceClient,
  MemoryAuthError,
  MemoryError,
  MemoryHttpError,
  MemoryInputError,
  MemoryNetworkError,
  MemoryNotFoundError,
  MemoryRateLimitError,
  MemoryServerError,
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

    useRetryTimers();
    const error = await settle(namespaces.list());
    expect(error).toBeInstanceOf(MemoryNetworkError);
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

  it("bounds remembered content at the bytes the service accepts", async () => {
    const bindingProfile = { remember: vi.fn() } as unknown as AgentMemoryProfileBinding;
    const binding = {
      getProfile: vi.fn(async () => bindingProfile),
      deleteProfile: vi.fn(),
    } as unknown as AgentMemoryNamespaceBinding;
    const selectedBindingProfile = await new CloudflareMemoryProvider({ binding }).getProfile(
      "user",
    );

    expect(() => selectedBindingProfile.remember({ content: "a".repeat(32_769) })).toThrow(
      "Memory content must not exceed 32768 UTF-8 bytes",
    );
    expect(bindingProfile.remember).not.toHaveBeenCalled();

    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(memory));
    const httpProvider = new CloudflareMemoryProvider({
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    });
    const selectedHttpProfile = await httpProvider.getProfile("user");

    /** 16,385 two-byte characters pass a character count and still exceed the byte cap. */
    await expect(
      selectedHttpProfile.remember({ content: "ł".repeat(16_385) }),
    ).rejects.toBeInstanceOf(MemoryInputError);
    expect(fetcher).not.toHaveBeenCalled();

    await selectedHttpProfile.remember({ content: "ł".repeat(16_384) });
    expect(fetcher).toHaveBeenCalledTimes(1);
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

    useRetryTimers();
    const recall = profile.recall("question").catch((cause: unknown) => cause);
    await settle(recall);
    expect(await recall).toBeInstanceOf(MemoryError);
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

    useRetryTimers();
    const recall = profile.recall("question").catch((cause: unknown) => cause);
    await settle(recall);
    expect(await recall).toBeInstanceOf(MemoryHttpError);
  });
});

describe("CloudflareMemoryProvider server and network failures", () => {
  /** Cloudflare's answer to an unknown id on 2026-10-05, ray id zeroed. A blip reads the same. */
  const serverFailure = {
    result: null,
    errors: [
      {
        code: 10000,
        message:
          "An error occurred processing your request. You may contact support with the following Cf-Ray request id: 0000000000000000",
      },
    ],
    messages: [],
    success: false,
  };
  const namespace = {
    id: "namespace-id",
    name: "test-namespace",
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
  };
  const passingNote = "which usually passes, so try the call again later";
  const writeNote =
    "a write that fails this way may still have landed, so repeat it only once a read shows it did not";

  function clients(fetcher: typeof fetch) {
    const options = {
      accountId: "account",
      namespace: "namespace",
      apiToken: "token",
      fetch: fetcher,
    };
    return {
      provider: new CloudflareMemoryProvider(options),
      namespaces: new CloudflareNamespaceClient(options),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tries a read again after a gateway failure and returns what the next try got", async () => {
    useRetryTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }))
      .mockResolvedValueOnce(Response.json(serverFailure, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(namespace));

    const result = await settle(clients(fetcher).namespaces.get("test-namespace"));

    expect(result).toMatchObject({ id: "namespace-id", name: "test-namespace" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([500, 501, 502, 503, 504, 520])(
    "names status %i and the passing failure once every try of a read ran out",
    async (status) => {
      useRetryTimers();
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(serverFailure, { status }));
      const { provider, namespaces } = clients(fetcher);
      const profile = await provider.getProfile("user");

      for (const operation of [
        () => profile.recall("question"),
        () => profile.list(),
        () => profile.getSummary(),
        () => namespaces.list(),
        () => namespaces.get("test-namespace"),
        () => namespaces.listProfiles("test-namespace"),
      ]) {
        fetcher.mockClear();
        const error = await settle(operation());
        expect(error).toBeInstanceOf(MemoryServerError);
        expect(error).toBeInstanceOf(MemoryHttpError);
        expect(error).toMatchObject({
          provider: "cloudflare",
          statusCode: status,
          message: `Cloudflare Agent Memory failed with ${status} after 3 attempts, ${passingNote}: ${serverFailure.errors[0]?.message}`,
        });
        expect(fetcher).toHaveBeenCalledTimes(3);
      }
    },
  );

  it("reads a memory by id once on 500, since the service also answers an unknown id that way", async () => {
    useRetryTimers();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(serverFailure, { status: 500 }));
    const profile = await clients(fetcher).provider.getProfile("user");

    const error = await settle(profile.get("memory-1"));

    expect(error).toBeInstanceOf(MemoryServerError);
    expect(error).toMatchObject({
      statusCode: 500,
      message: `Cloudflare Agent Memory failed with 500: ${serverFailure.errors[0]?.message}`,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("tries a read by id again on a gateway failure", async () => {
    useRetryTimers();
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("<html>Service unavailable</html>", { status: 503 }),
    );
    const profile = await clients(fetcher).provider.getProfile("user");

    const error = await settle(profile.get("memory-1"));

    expect(error).toMatchObject({
      statusCode: 503,
      message: `Cloudflare Agent Memory failed with 503 after 3 attempts, ${passingNote}`,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("names the last failure, not every one, when the tries failed differently", async () => {
    useRetryTimers();
    const cause = new TypeError("fetch failed");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockRejectedValue(cause);

    const error = await settle(clients(fetcher).namespaces.list());

    expect(error).toBeInstanceOf(MemoryNetworkError);
    expect(error).toMatchObject({
      message: `No complete answer came back from Cloudflare Agent Memory after 3 attempts, ${passingNote}`,
      cause,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("tries a read again when its body breaks off halfway", async () => {
    useRetryTimers();
    const broken = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":true,'));
        controller.error(new TypeError("terminated"));
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(broken))
      .mockResolvedValueOnce(jsonResponse(namespace));

    const result = await settle(clients(fetcher).namespaces.get("test-namespace"));

    expect(result).toMatchObject({ id: "namespace-id" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not JSON", "not JSON"],
    ["an envelope", '{"result":{}}'],
    ["a result", '{"success":true,"errors":[],"result":{}}'],
  ])("says a write may have landed when a 2xx answer holds no readable %s", async (_part, body) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    const profile = await clients(fetcher).provider.getProfile("user");

    const error = await profile.remember({ content: "x" }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MemoryHttpError);
    expect(error).toMatchObject({
      statusCode: 200,
      message: `Cloudflare Agent Memory answered the write with 200 and a body it could not read, and ${writeNote}`,
    });
    expect(error).toHaveProperty("cause.name", "MemoryHttpError");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a write refused in a 2xx envelope free of the landed note", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ success: false, errors: [{ message: "content is empty" }] }),
    );
    const profile = await clients(fetcher).provider.getProfile("user");

    await expect(profile.remember({ content: "x" })).rejects.toMatchObject({
      statusCode: 200,
      message: "content is empty",
    });
  });

  it.each([400, 403, 404, 429])("fails a read on %i without another try", async (status) => {
    useRetryTimers();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(serverFailure, { status }));

    const error = await settle(clients(fetcher).namespaces.list());

    expect(error).toBeInstanceOf(MemoryHttpError);
    expect(error).not.toBeInstanceOf(MemoryServerError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends a write once and says a server failure leaves its outcome open", async () => {
    useRetryTimers();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(serverFailure, { status: 503 }));
    const { provider, namespaces } = clients(fetcher);
    const profile = await provider.getProfile("user");

    for (const operation of [
      () => profile.ingest([{ role: "user", content: "x" }]),
      () => profile.remember({ content: "x" }),
      () => profile.delete("memory-1"),
      () => profile.deleteSession("session-1"),
      () => provider.deleteProfile("user"),
      () => namespaces.create("test-namespace"),
      () => namespaces.delete("test-namespace"),
    ]) {
      fetcher.mockClear();
      const error = await settle(operation());
      expect(error).toBeInstanceOf(MemoryServerError);
      expect(error).toMatchObject({
        statusCode: 503,
        message: `Cloudflare Agent Memory failed with 503, and ${writeNote}: ${serverFailure.errors[0]?.message}`,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the network cause and tries a read three times when no answer comes back", async () => {
    useRetryTimers();
    const cause = new TypeError("fetch failed", {
      cause: new Error("getaddrinfo ENOTFOUND api.cloudflare.com"),
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw cause;
    });

    const error = await settle(clients(fetcher).namespaces.list());

    expect(error).toBeInstanceOf(MemoryNetworkError);
    expect(error).toMatchObject({
      provider: "cloudflare",
      message: `No complete answer came back from Cloudflare Agent Memory after 3 attempts, ${passingNote}`,
      cause,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("sends a write once when no answer comes back", async () => {
    useRetryTimers();
    const cause = new TypeError("fetch failed");
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw cause;
    });
    const profile = await clients(fetcher).provider.getProfile("user");

    const error = await settle(profile.remember({ content: "x" }));

    expect(error).toBeInstanceOf(MemoryNetworkError);
    expect(error).toMatchObject({
      message: `No complete answer came back from Cloudflare Agent Memory, and ${writeNote}`,
      cause,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops between two tries the moment the caller aborts", async () => {
    useRetryTimers();
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const fetcher = vi.fn<typeof fetch>(async () => {
      queueMicrotask(() => {
        controller.abort(reason);
      });
      return new Response(null, { status: 502 });
    });

    const error = await settle(clients(fetcher).namespaces.list({ signal: controller.signal }));

    expect(error).toBeInstanceOf(MemoryError);
    expect(error).not.toBeInstanceOf(MemoryServerError);
    expect(error).toHaveProperty("cause", reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["read", "write"])(
    "does not report a %s the caller aborted as a network failure",
    async (kind) => {
      useRetryTimers();
      const controller = new AbortController();
      const reason = new Error("caller gave up");
      const fetcher = vi.fn<typeof fetch>(async () => {
        controller.abort(reason);
        throw reason;
      });
      const { provider, namespaces } = clients(fetcher);
      const profile = await provider.getProfile("user");
      const options = { signal: controller.signal };

      const error = await settle(
        kind === "read" ? namespaces.list(options) : profile.remember({ content: "x" }, options),
      );

      expect(error).not.toBeInstanceOf(MemoryNetworkError);
      expect(error).toHaveProperty("cause", reason);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
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
