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

export interface IngestOptions {
  sessionId?: string | null;
}
export interface RememberInput {
  content: string;
  sessionId?: string | null;
}
export interface RecallOptions {
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
export interface ListOptions {
  limit?: number;
  cursor?: string;
  sessionId?: string;
  type?: MemoryType;
}
export interface ListResult {
  memories: MemoryListEntry[];
  cursor?: string;
}
export interface SummaryOptions {
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
