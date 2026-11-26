import type {
  AbortOptions,
  CloudflareAccountOptions,
  MemoryProvider,
  MemoryType,
  migrateMemories,
  ResponseLength,
  ThinkingLevel,
} from "@agntn/memory";
import type { MemoryRelation } from "./memory-relations.ts";

export interface NamespaceResult {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileResult {
  name: string;
  createdAt: Date;
}

export interface MemoryModule {
  registerAll(): void;
  migrateMemories: typeof migrateMemories;
  create<TOptions>(name: string, options: TOptions): MemoryProvider;
  CloudflareNamespaceClient: new (options?: CloudflareAccountOptions) => {
    list(options?: NamespaceListParams & AbortOptions): Promise<{
      namespaces: NamespaceResult[];
      cursor?: string;
    }>;
    get(name: string, options?: AbortOptions): Promise<NamespaceResult>;
    create(name: string, options?: AbortOptions): Promise<NamespaceResult>;
    delete(name: string, options?: AbortOptions): Promise<void>;
    listProfiles(
      name: string,
      options?: { limit?: number; cursor?: string } & AbortOptions,
    ): Promise<{ profiles: ProfileResult[]; cursor?: string }>;
  };
}

export interface ProfileParams {
  namespace: string;
  profile: string;
}

export interface NamespaceParams {
  namespace: string;
}

export interface NamespaceListParams {
  limit?: number;
  cursor?: string;
  order?: "id" | "name";
  direction?: "asc" | "desc";
}

export interface ProfileListParams extends NamespaceParams {
  limit?: number;
  cursor?: string;
}

export interface RememberParams extends ProfileParams {
  content: string;
  sessionId?: string;
  /** More profiles that get the same content and session, written after the main one. */
  copies?: readonly ProfileParams[];
  /** Ends each copy with a line naming the main record. */
  copySource?: boolean;
  /** List what each write superseded, for one recall and some reads per profile. */
  reportSuperseded?: boolean;
  /** Older memories in this profile it bears on, each ending the content as a relates: line. */
  relates?: readonly MemoryRelation[];
}

/** A copy of the old memory in another profile. */
export interface SupersedeCopyParams extends ProfileParams {
  /** The old copy's id; left out, its Copied from memory line finds it. */
  oldMemoryId?: string;
}

export interface SupersedeParams extends ProfileParams {
  oldMemoryId: string;
  content: string;
  query: string;
  timeoutSeconds: number;
  sessionId?: string;
  /** Copies of the old memory, replaced once the main one is. */
  copies?: readonly SupersedeCopyParams[];
  /** Ends each new copy with a line naming the main replacement. */
  copySource?: boolean;
  /** List what the replacement's own write superseded. */
  reportSuperseded?: boolean;
}

export interface ResumeSupersessionParams extends ProfileParams {
  oldMemoryId: string;
  replacementMemoryId: string;
  content: string;
  query: string;
  timeoutSeconds: number;
}

export interface IngestParams extends ProfileParams {
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
    timestamp?: string;
  }>;
  sessionId?: string;
}

export interface RecallParams extends ProfileParams {
  query: string;
  thinkingLevel?: ThinkingLevel;
  responseLength?: ResponseLength;
  referenceDate?: string;
  candidates?: number;
  expand?: number;
}

export interface RecallVisibilityParams extends ProfileParams {
  memoryId: string;
  query: string;
  timeoutSeconds: number;
}

export interface ListParams extends ProfileParams {
  limit?: number;
  cursor?: string;
  sessionId?: string;
  type?: MemoryType;
  expand?: number;
}

export interface GetParams extends ProfileParams {
  memoryIds: string[];
  /** Name the memory that superseded each superseded record. */
  reportSuccessor?: boolean;
  /** List the memories whose relates: lines name each record. */
  reportRelations?: boolean;
}

export interface MemoryParams extends ProfileParams {
  memoryId: string;
}

export interface SessionParams extends ProfileParams {
  sessionId: string;
}

export interface SummaryParams extends ProfileParams {
  sessionId?: string;
}

export interface MigrateParams extends ProfileParams {
  /** Left out, the source namespace. */
  targetNamespace?: string;
  /** Left out, the source profile name. */
  targetProfile?: string;
  dryRun?: boolean;
  keepSource?: boolean;
  /** End each new record with a line naming its old id. */
  copySource?: boolean;
}

export interface MemoryToolResult {
  content: Array<{ type: "text"; text: string }>;
  /** MCP clients never see this, so the text carries everything the caller needs. */
  details: Record<string, unknown>;
}
