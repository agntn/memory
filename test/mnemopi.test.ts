import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  create,
  registerAll,
  type MnemopiClient,
  type MnemopiMemoryOptions,
} from "../src/index.ts";

const createdAt = "2026-08-16T12:00:00.000Z";

function createFakeClient(bank: string, sessionId = "default"): MnemopiClient {
  const memories = new Map<string, Record<string, unknown>>();
  return {
    bank,
    sessionId,
    remember(memory, options) {
      const id = `memory-${memories.size + 1}`;
      memories.set(id, {
        id,
        content: memory.content,
        source: options?.source ?? null,
        session_id: memory.session_id ?? "default",
        memory_type: memory.memory_type ?? "fact",
        created_at: createdAt,
      });
      return id;
    },
    async recall(query) {
      return [...memories.values()]
        .filter((memory) => String(memory.content).includes(query))
        .map((memory) => ({ ...memory, score: 0.9 }));
    },
    get(memoryId) {
      return memories.get(memoryId) ?? null;
    },
    close() {},
  };
}

describe("Mnemopi memory provider", () => {
  beforeEach(() => registerAll());

  it("creates one Mnemopi bank client per profile", async () => {
    const createClient = vi.fn((profileName: string) => createFakeClient(profileName));
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient,
    });

    await provider.getProfile("project-a");
    await provider.getProfile("project-b");

    expect(createClient).toHaveBeenNthCalledWith(1, "project-a");
    expect(createClient).toHaveBeenNthCalledWith(2, "project-b");
    expect(provider.capabilities).toEqual({
      ingest: false,
      remember: true,
      recall: true,
      list: false,
      get: true,
      delete: false,
      deleteSession: false,
      summary: false,
      deleteProfile: false,
      listProfiles: true,
    });
  });

  it("lists and deduplicates Mnemopi banks without opening them", async () => {
    const createClient = vi.fn((profileName: string) => createFakeClient(profileName));
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      createClient,
      listProfiles: async () => ["default", "project-a", "project-a"],
    });

    await expect(provider.listProfiles?.()).resolves.toEqual(["default", "project-a"]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses a bank listing the caller already cancelled", async () => {
    const listProfiles = vi.fn(async () => ["default"]);
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      createClient: (profileName) => createFakeClient(profileName),
      listProfiles,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.listProfiles?.({ signal: controller.signal })).rejects.toThrow();
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it("maps remember, get, and recall to the unified contract", async () => {
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient: (profileName) => createFakeClient(profileName, "s1"),
    });
    const profile = await provider.getProfile("project");

    const remembered = await profile.remember?.({
      content: "deploy to stable-cluster",
      sessionId: "s1",
    });
    expect(remembered).toEqual({
      id: "memory-1",
      type: "fact",
      summary: "deploy to stable-cluster",
      content: "deploy to stable-cluster",
      sessionId: "s1",
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
    await expect(profile.get?.("memory-1")).resolves.toEqual(remembered);
    await expect(profile.recall?.("stable-cluster")).resolves.toEqual({
      count: 1,
      answer: "deploy to stable-cluster",
      candidates: [
        {
          id: "memory-1",
          summary: "deploy to stable-cluster",
          sessionId: "s1",
          score: 0.9,
        },
      ],
    });
    expect(profile.delete).toBeUndefined();
  });

  it("passes referenceDate to Mnemopi temporal recall", async () => {
    const client = createFakeClient("project");
    const recall = vi.spyOn(client, "recall");
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient: () => client,
    });
    const profile = await provider.getProfile("project");

    await profile.recall?.("deployment", {
      referenceDate: "2026-08-16T12:00:00.000Z",
    });

    expect(recall).toHaveBeenCalledWith("deployment", 5, {
      query_time: "2026-08-16T12:00:00.000Z",
    });
  });

  it("reuses profile clients and closes their background work", async () => {
    const client = createFakeClient("project");
    const flushExtractions = vi.fn(async () => {});
    const close = vi.fn();
    client.flushExtractions = flushExtractions;
    client.close = close;
    const createClient = vi.fn(() => client);
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient,
    });

    const first = await provider.getProfile("project");
    const second = await provider.getProfile("project");
    expect(second).toBe(first);
    expect(createClient).toHaveBeenCalledOnce();

    await provider.close?.();

    expect(flushExtractions).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(provider.getProfile("project")).rejects.toThrow("Mnemopi provider is closed");
  });

  it("uses a fact timestamp when its created_at is absent", async () => {
    const client = createFakeClient("project");
    client.get = () => ({
      id: "fact-1",
      content: "project uses pnpm",
      session_id: "default",
      created_at: null,
      timestamp: createdAt,
    });
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient: () => client,
    });
    const profile = await provider.getProfile("project");

    await expect(profile.get?.("fact-1")).resolves.toMatchObject({
      id: "fact-1",
      createdAt: new Date(createdAt),
    });
  });

  it("rejects invalid bank names before constructing a client", async () => {
    const createClient = vi.fn((profileName: string) => createFakeClient(profileName));
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient,
    });

    await expect(provider.getProfile("../outside")).rejects.toMatchObject({
      provider: "mnemopi",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("closes clients when extraction flushing fails", async () => {
    const client = createFakeClient("project");
    client.flushExtractions = vi.fn(async () => {
      throw new Error("flush failed");
    });
    const close = vi.fn();
    client.close = close;
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient: () => client,
    });
    await provider.getProfile("project");

    await expect(provider.close?.()).rejects.toMatchObject({
      message: "flush failed",
      provider: "mnemopi",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects session IDs outside the Mnemopi client session", async () => {
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient: (profileName) => createFakeClient(profileName),
    });
    const profile = await provider.getProfile("project");

    await expect(
      profile.remember?.({ content: "unreachable memory", sessionId: "another-session" }),
    ).rejects.toMatchObject({
      message: "Mnemopi profile uses session default, not another-session",
      provider: "mnemopi",
    });
  });

  it("closes malformed clients returned by the factory", async () => {
    const close = vi.fn();
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient: () =>
        ({
          bank: "project",
          sessionId: "project",
          remember: vi.fn(),
          recall: vi.fn(),
          close,
        }) as unknown as MnemopiClient,
    });

    await expect(provider.getProfile("project")).rejects.toMatchObject({
      message: "Mnemopi client is invalid",
      provider: "mnemopi",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("normalizes client failures", async () => {
    const provider = create<MnemopiMemoryOptions>("mnemopi", {
      listProfiles: () => [],
      createClient() {
        throw new Error("database unavailable");
      },
    });

    await expect(provider.getProfile("project")).rejects.toMatchObject({
      message: "database unavailable",
      provider: "mnemopi",
    });
  });
});
