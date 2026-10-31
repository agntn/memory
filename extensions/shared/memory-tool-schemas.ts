import { Type, type TObject } from "@agntn/tools";
import {
  ISO_INSTANT_PATTERN,
  MAX_TOOL_INGEST_MESSAGES,
  MAX_TOOL_LIST_LIMIT,
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MAX_TOOL_MESSAGE_CHARACTERS,
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
  MAX_TOOL_EXPAND,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_ID_PATTERN,
  MEMORY_NAME_PATTERN,
  memoryFieldDescriptions,
} from "./memory-tool-contract.ts";
import type { ProfileParams } from "./memory-tools.types.ts";

/** Parameter schemas of the memory tools. OMP rewrites a bare `typebox` import, so none here. */
/** `defineTool` refuses open objects: a misspelled key would change the call silently. */
const closed = { additionalProperties: false } as const;
const namespaceName = Type.String({
  description: memoryFieldDescriptions.namespace,
  minLength: 1,
  maxLength: MAX_TOOL_NAMESPACE_CHARACTERS,
  pattern: MEMORY_NAME_PATTERN,
});
const profileParameters = {
  namespace: namespaceName,
  profile: Type.String({
    description: memoryFieldDescriptions.profile,
    minLength: 1,
    maxLength: MAX_TOOL_PROFILE_CHARACTERS,
    pattern: MEMORY_NAME_PATTERN,
  }),
};
const memoryId = Type.String({
  description: memoryFieldDescriptions.memoryId,
  minLength: 1,
  pattern: MEMORY_ID_PATTERN,
});

export const namespaceParameters = Type.Object({ namespace: namespaceName }, closed);
export const namespaceListParameters = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_LIST_LIMIT,
        description: memoryFieldDescriptions.namespacesPerPage,
      }),
    ),
    cursor: Type.Optional(Type.String({ description: memoryFieldDescriptions.cursor })),
    order: Type.Optional(
      Type.Enum(["id", "name"], { description: memoryFieldDescriptions.sortField }),
    ),
    direction: Type.Optional(
      Type.Enum(["asc", "desc"], { description: memoryFieldDescriptions.sortDirection }),
    ),
  },
  closed,
);
export const profileListParameters = Type.Object(
  {
    namespace: namespaceName,
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_LIST_LIMIT,
        description: memoryFieldDescriptions.profilesPerPage,
      }),
    ),
    cursor: Type.Optional(Type.String({ description: memoryFieldDescriptions.cursor })),
  },
  closed,
);
export const rememberParameters = Type.Object(
  {
    ...profileParameters,
    content: Type.String({
      description: memoryFieldDescriptions.rememberContent,
      minLength: 1,
      maxLength: MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
    }),
    sessionId: Type.Optional(
      Type.String({
        description: memoryFieldDescriptions.writeSessionId,
        maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
      }),
    ),
  },
  closed,
);
export const supersedeParameters = Type.Object(
  {
    ...profileParameters,
    oldMemoryId: Type.String({
      description: memoryFieldDescriptions.supersedeOldMemoryId,
      minLength: 1,
      pattern: MEMORY_ID_PATTERN,
    }),
    content: Type.String({
      description: memoryFieldDescriptions.rememberContent,
      minLength: 1,
      maxLength: MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
    }),
    query: Type.String({
      description: memoryFieldDescriptions.recallVisibilityQuery,
      minLength: 1,
      maxLength: MAX_TOOL_QUERY_CHARACTERS,
    }),
    timeoutSeconds: Type.Integer({
      description: memoryFieldDescriptions.recallVisibilityTimeout,
      minimum: 1,
      maximum: MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
    }),
    sessionId: Type.Optional(
      Type.String({
        description: memoryFieldDescriptions.writeSessionId,
        maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
      }),
    ),
  },
  closed,
);
export const resumeSupersessionParameters = Type.Object(
  {
    ...profileParameters,
    oldMemoryId: Type.String({
      description: memoryFieldDescriptions.supersedeOldMemoryId,
      minLength: 1,
      pattern: MEMORY_ID_PATTERN,
    }),
    replacementMemoryId: Type.String({
      description: memoryFieldDescriptions.supersedeReplacementMemoryId,
      minLength: 1,
      pattern: MEMORY_ID_PATTERN,
    }),
    content: Type.String({
      description: memoryFieldDescriptions.replacementContent,
      minLength: 1,
    }),
    query: Type.String({
      description: memoryFieldDescriptions.recallVisibilityQuery,
      minLength: 1,
      maxLength: MAX_TOOL_QUERY_CHARACTERS,
    }),
    timeoutSeconds: Type.Integer({
      description: memoryFieldDescriptions.recallVisibilityTimeout,
      minimum: 1,
      maximum: MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
    }),
  },
  closed,
);
export const recallVisibilityParameters = Type.Object(
  {
    ...profileParameters,
    memoryId: Type.String({
      description: memoryFieldDescriptions.recallVisibilityMemoryId,
      minLength: 1,
      pattern: MEMORY_ID_PATTERN,
    }),
    query: Type.String({
      description: memoryFieldDescriptions.recallVisibilityQuery,
      minLength: 1,
      maxLength: MAX_TOOL_QUERY_CHARACTERS,
    }),
    timeoutSeconds: Type.Integer({
      description: memoryFieldDescriptions.recallVisibilityTimeout,
      minimum: 1,
      maximum: MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
    }),
  },
  closed,
);
export const ingestParameters = Type.Object(
  {
    ...profileParameters,
    messages: Type.Array(
      Type.Object(
        {
          role: Type.Enum(["system", "user", "assistant"], {
            description: memoryFieldDescriptions.messageRole,
          }),
          content: Type.String({
            description: memoryFieldDescriptions.messageContent,
            minLength: 1,
            maxLength: MAX_TOOL_MESSAGE_CHARACTERS,
          }),
          timestamp: Type.Optional(
            Type.String({
              description: memoryFieldDescriptions.messageTimestamp,
              pattern: ISO_INSTANT_PATTERN,
            }),
          ),
        },
        closed,
      ),
      {
        minItems: 1,
        maxItems: MAX_TOOL_INGEST_MESSAGES,
        description: memoryFieldDescriptions.messages,
      },
    ),
    sessionId: Type.Optional(
      Type.String({
        description: memoryFieldDescriptions.writeSessionId,
        maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
      }),
    ),
  },
  closed,
);
export const recallParameters = Type.Object(
  {
    ...profileParameters,
    query: Type.String({
      description: memoryFieldDescriptions.recallQuery,
      minLength: 1,
      maxLength: MAX_TOOL_QUERY_CHARACTERS,
    }),
    thinkingLevel: Type.Optional(
      Type.Enum(["low", "medium", "high"], { description: memoryFieldDescriptions.thinkingLevel }),
    ),
    responseLength: Type.Optional(
      Type.Enum(["short", "medium", "long"], {
        description: memoryFieldDescriptions.responseLength,
      }),
    ),
    referenceDate: Type.Optional(
      Type.String({ description: memoryFieldDescriptions.referenceDate }),
    ),
    candidates: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_EXPAND,
        description: memoryFieldDescriptions.candidates,
      }),
    ),
    expand: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_EXPAND,
        description: memoryFieldDescriptions.expand,
      }),
    ),
  },
  closed,
);
export const listParameters = Type.Object(
  {
    ...profileParameters,
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_LIST_LIMIT,
        description: memoryFieldDescriptions.memoriesPerPage,
      }),
    ),
    cursor: Type.Optional(Type.String({ description: memoryFieldDescriptions.cursor })),
    sessionId: Type.Optional(
      Type.String({
        description: memoryFieldDescriptions.listSessionId,
        maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
      }),
    ),
    type: Type.Optional(
      Type.Enum(["fact", "event", "instruction", "task"], {
        description: memoryFieldDescriptions.memoryType,
      }),
    ),
    expand: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_EXPAND,
        description: memoryFieldDescriptions.listExpand,
      }),
    ),
  },
  closed,
);
export const getParameters = Type.Object(
  {
    ...profileParameters,
    memoryIds: Type.Array(memoryId, {
      minItems: 1,
      maxItems: MAX_TOOL_EXPAND,
      description: memoryFieldDescriptions.memoryIds,
    }),
  },
  closed,
);
export const memoryParameters = Type.Object(
  {
    ...profileParameters,
    memoryId,
  },
  closed,
);
export const sessionParameters = Type.Object(
  {
    ...profileParameters,
    sessionId: Type.String({
      description: memoryFieldDescriptions.sessionToDelete,
      minLength: 1,
      maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
      pattern: MEMORY_ID_PATTERN,
    }),
  },
  closed,
);
export const summaryParameters = Type.Object(
  {
    ...profileParameters,
    sessionId: Type.Optional(
      Type.String({
        description: memoryFieldDescriptions.summarySessionId,
        maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
      }),
    ),
  },
  closed,
);
export const profileOnlyParameters = Type.Object(profileParameters, closed);

/**
 * Namespace and profile as a bound host offers them: optional, and named after the default.
 *
 * @param target - The bound `namespace/profile`, for the descriptions.
 * @returns {object} Optional namespace and profile properties.
 */
function boundProfileParameters(target: string) {
  return {
    namespace: Type.Optional(
      Type.String({
        description: memoryFieldDescriptions.boundNamespace(target),
        minLength: 1,
        maxLength: MAX_TOOL_NAMESPACE_CHARACTERS,
        pattern: MEMORY_NAME_PATTERN,
      }),
    ),
    profile: Type.Optional(
      Type.String({
        description: memoryFieldDescriptions.boundProfile(target),
        minLength: 1,
        maxLength: MAX_TOOL_PROFILE_CHARACTERS,
        pattern: MEMORY_NAME_PATTERN,
      }),
    ),
  };
}

/** The operational schemas as an unbound host serves them, namespace and profile required. */
const rawOperationalSchemas = {
  rememberParameters,
  supersedeParameters,
  resumeSupersessionParameters,
  recallVisibilityParameters,
  ingestParameters,
  recallParameters,
  listParameters,
  getParameters,
  memoryParameters,
  summaryParameters,
  sessionParameters,
};

type OperationalSchemaName = keyof typeof rawOperationalSchemas;

/** Writes whose session the host stamps itself, so a bound model never gets to pass one. */
const hostSessionSchemas: ReadonlySet<OperationalSchemaName> = new Set([
  "rememberParameters",
  "supersedeParameters",
  "ingestParameters",
]);

/**
 * One operational schema under a bound scope: the pair turns optional, a write loses `sessionId`.
 *
 * @param name - Which raw schema to rebuild.
 * @param target - The bound `namespace/profile`.
 * @returns {TObject} The closed schema the model sees.
 */
function boundSchema(name: OperationalSchemaName, target: string): TObject {
  const hostOwned = hostSessionSchemas.has(name) ? ["sessionId"] : [];
  const rest = Type.Omit(
    rawOperationalSchemas[name],
    ["namespace", "profile", ...hostOwned],
    closed,
  );
  return Type.Object({ ...boundProfileParameters(target), ...rest.properties }, closed);
}

/**
 * Build the model-facing schemas for raw administration or for a host that binds a default scope.
 *
 * @param scope - Namespace and profile the host defaults to, if any.
 * @returns {Record<OperationalSchemaName, TObject>} The schemas the model sees.
 */
export function createOperationalMemoryToolSchemas(
  scope: ProfileParams | undefined,
): Record<OperationalSchemaName, TObject> {
  if (scope === undefined) return rawOperationalSchemas;
  const target = `${scope.namespace}/${scope.profile}`;
  const names = Object.keys(rawOperationalSchemas) as OperationalSchemaName[];
  return Object.fromEntries(names.map((name) => [name, boundSchema(name, target)])) as Record<
    OperationalSchemaName,
    TObject
  >;
}
