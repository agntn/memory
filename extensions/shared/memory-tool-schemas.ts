import { Type, type TObject } from "@agntn/tools";
import {
  ISO_INSTANT_PATTERN,
  MAX_TOOL_INGEST_MESSAGES,
  MAX_TOOL_LIST_LIMIT,
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MAX_TOOL_MEMORY_COPIES,
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
/**
 * One name rule for every namespace field, whatever its description says.
 *
 * @param description - What the field means where it sits.
 * @returns {TString} The namespace schema.
 */
function namespaceString(description: string) {
  return Type.String({
    description,
    minLength: 1,
    maxLength: MAX_TOOL_NAMESPACE_CHARACTERS,
    pattern: MEMORY_NAME_PATTERN,
  });
}
/**
 * One name rule for every profile field, whatever its description says.
 *
 * @param description - What the field means where it sits.
 * @returns {TString} The profile schema.
 */
function profileString(description: string) {
  return Type.String({
    description,
    minLength: 1,
    maxLength: MAX_TOOL_PROFILE_CHARACTERS,
    pattern: MEMORY_NAME_PATTERN,
  });
}
const namespaceName = namespaceString(memoryFieldDescriptions.namespace);
const profileParameters = {
  namespace: namespaceName,
  profile: profileString(memoryFieldDescriptions.profile),
};
const memoryId = Type.String({
  description: memoryFieldDescriptions.memoryId,
  minLength: 1,
  pattern: MEMORY_ID_PATTERN,
});
const oldMemoryId = Type.String({
  description: memoryFieldDescriptions.supersedeOldMemoryId,
  minLength: 1,
  pattern: MEMORY_ID_PATTERN,
});
/** One recall poll, three callers: `memory_recall_wait` and both supersession tools. */
const recallCheckParameters = {
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
};

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
    copies: Type.Optional(
      Type.Array(
        Type.Object(
          {
            namespace: namespaceString(memoryFieldDescriptions.copyNamespace),
            profile: profileString(memoryFieldDescriptions.copyProfile),
          },
          closed,
        ),
        {
          description: memoryFieldDescriptions.rememberCopies,
          minItems: 1,
          maxItems: MAX_TOOL_MEMORY_COPIES,
        },
      ),
    ),
  },
  closed,
);
export const supersedeParameters = Type.Object(
  {
    ...profileParameters,
    oldMemoryId,
    content: Type.String({
      description: memoryFieldDescriptions.rememberContent,
      minLength: 1,
      maxLength: MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
    }),
    ...recallCheckParameters,
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
    oldMemoryId,
    replacementMemoryId: Type.String({
      description: memoryFieldDescriptions.supersedeReplacementMemoryId,
      minLength: 1,
      pattern: MEMORY_ID_PATTERN,
    }),
    content: Type.String({
      description: memoryFieldDescriptions.replacementContent,
      minLength: 1,
    }),
    ...recallCheckParameters,
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
    ...recallCheckParameters,
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
    namespace: Type.Optional(namespaceString(memoryFieldDescriptions.boundNamespace(target))),
    profile: Type.Optional(profileString(memoryFieldDescriptions.boundProfile(target))),
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
 * One operational schema with no namespace or profile, and no `sessionId` on a write.
 *
 * @param name - Which raw schema to rebuild.
 * @returns {TObject} The closed schema a locked tool takes.
 */
function scopelessSchema(name: OperationalSchemaName): TObject {
  const hostOwned = hostSessionSchemas.has(name) ? ["sessionId"] : [];
  return Type.Omit(rawOperationalSchemas[name], ["namespace", "profile", ...hostOwned], closed);
}

/**
 * One operational schema under a bound scope: the pair turns optional, a write loses `sessionId`.
 *
 * @param name - Which raw schema to rebuild.
 * @param target - The bound `namespace/profile`.
 * @returns {TObject} The closed schema the model sees.
 */
function boundSchema(name: OperationalSchemaName, target: string): TObject {
  return Type.Object(
    { ...boundProfileParameters(target), ...scopelessSchema(name).properties },
    closed,
  );
}

/**
 * Rebuild every operational schema the same way.
 *
 * @param rebuild - Turns one raw schema name into the schema the model sees.
 * @returns {Record<OperationalSchemaName, TObject>} The rebuilt schemas.
 */
function rebuildOperationalSchemas(
  rebuild: (name: OperationalSchemaName) => TObject,
): Record<OperationalSchemaName, TObject> {
  const names = Object.keys(rawOperationalSchemas) as OperationalSchemaName[];
  return Object.fromEntries(names.map((name) => [name, rebuild(name)])) as Record<
    OperationalSchemaName,
    TObject
  >;
}

/**
 * The schemas of a surface locked to one profile: no scope fields, no `sessionId` on a write,
 * and no `copies`, which would carry a write out of that profile.
 *
 * @returns {Record<OperationalSchemaName, TObject>} The schemas the model sees.
 */
export function createLockedMemoryToolSchemas(): Record<OperationalSchemaName, TObject> {
  return rebuildOperationalSchemas((name) =>
    name === "rememberParameters"
      ? Type.Omit(scopelessSchema(name), ["copies"], closed)
      : scopelessSchema(name),
  );
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
  return rebuildOperationalSchemas((name) => boundSchema(name, target));
}
