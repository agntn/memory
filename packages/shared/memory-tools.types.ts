import type {
  AbortOptions,
  MemoryProvider,
  MemoryType,
  ResponseLength,
  ThinkingLevel,
} from "@agntn/memory";

export interface NamespaceResult {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryModule {
  registerAll(): void;
  create<TOptions>(name: string, options: TOptions): MemoryProvider;
  CloudflareNamespaceClient: new (options: { accountId: string; apiToken: string }) => {
    list(options?: NamespaceListParams & AbortOptions): Promise<{
      namespaces: NamespaceResult[];
      cursor?: string;
    }>;
    get(name: string, options?: AbortOptions): Promise<NamespaceResult>;
    create(name: string, options?: AbortOptions): Promise<NamespaceResult>;
    delete(name: string, options?: AbortOptions): Promise<void>;
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

export interface RememberParams extends ProfileParams {
  content: string;
  sessionId?: string;
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

export interface ListParams extends ProfileParams {
  limit?: number;
  cursor?: string;
  sessionId?: string;
  type?: MemoryType;
  expand?: number;
}

export interface GetParams extends ProfileParams {
  memoryIds: string[];
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

export interface MemoryToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}
