import type {
  AbortOptions,
  IngestOptions,
  ListOptions,
  ListResult,
  Memory,
  MemoryCapabilities,
  MemoryMessage,
  RecallOptions,
  RecallResult,
  RememberInput,
  SummaryOptions,
  SummaryResult,
} from "./types.ts";

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- Interface merging preserves optional method absence at runtime.
export abstract class MemoryProfile {}

export interface MemoryProfile {
  ingest?(messages: Iterable<Readonly<MemoryMessage>>, options?: IngestOptions): Promise<void>;
  remember?(memory: RememberInput, options?: AbortOptions): Promise<Memory>;
  recall?(query: string, options?: RecallOptions): Promise<RecallResult>;
  list?(options?: ListOptions): Promise<ListResult>;
  get?(memoryId: string, options?: AbortOptions): Promise<Memory>;
  delete?(memoryId: string, options?: AbortOptions): Promise<Memory>;
  deleteSession?(sessionId: string, options?: AbortOptions): Promise<void>;
  getSummary?(options?: SummaryOptions): Promise<SummaryResult>;
}

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- Interface merging preserves optional method absence at runtime.
export abstract class MemoryProvider {
  abstract readonly name: string;
  abstract readonly capabilities: Readonly<MemoryCapabilities>;
  abstract getProfile(profileName: string): Promise<MemoryProfile>;
}

export interface MemoryProvider {
  deleteProfile?(profileName: string, options?: AbortOptions): Promise<void>;
  /** Enumerates profile names when the provider supports discovery. */
  listProfiles?(options?: AbortOptions): Promise<string[]>;
  /** Releases resources owned by the provider. */
  close?(): Promise<void>;
}
