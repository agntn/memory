export type MemoryType = "fact" | "event" | "instruction" | "task";
export type MessageRole = "system" | "user" | "assistant";
export type ThinkingLevel = "low" | "medium" | "high";
export type ResponseLength = "short" | "medium" | "long";

export interface Memory {
  id: string;
  type: MemoryType;
  summary: string;
  content: string;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MemoryListEntry = Omit<Memory, "content">;

export interface MemoryMessage {
  role: MessageRole;
  content: string;
  timestamp?: Date;
}

/**
 * Cancellation for a single call.
 *
 * The HTTP transport hands the signal to `fetch`, so aborting stops the request
 * while it is still in flight. A Cloudflare binding and the Mnemopi client run
 * in process and cannot be interrupted once they start, so there the signal is
 * checked at the call boundary and the call rejects instead of returning a
 * result nobody is waiting for.
 */
export interface AbortOptions {
  signal?: AbortSignal;
}

export interface IngestOptions extends AbortOptions {
  sessionId?: string | null;
}
export interface RememberInput {
  content: string;
  sessionId?: string | null;
}
export interface RecallOptions extends AbortOptions {
  thinkingLevel?: ThinkingLevel;
  responseLength?: ResponseLength;
  referenceDate?: Date | string;
}
export interface RecallCandidate {
  id: string;
  summary: string;
  sessionId: string | null;
  score: number;
}
export interface RecallResult {
  count: number;
  answer: string;
  candidates: RecallCandidate[];
}
export interface ListOptions extends AbortOptions {
  limit?: number;
  cursor?: string;
  sessionId?: string;
  type?: MemoryType;
}
export interface ListResult {
  memories: MemoryListEntry[];
  cursor?: string;
}
export interface SummaryOptions extends AbortOptions {
  sessionId?: string | null;
}
export interface SummaryResult {
  summary: string;
}

export interface MemoryCapabilities {
  ingest: boolean;
  remember: boolean;
  recall: boolean;
  list: boolean;
  get: boolean;
  delete: boolean;
  deleteSession: boolean;
  summary: boolean;
  deleteProfile: boolean;
  /** Whether the provider can enumerate profile names. */
  listProfiles: boolean;
}
