import { Type } from "typebox";
import {
  ISO_INSTANT_PATTERN,
  MAX_TOOL_INGEST_MESSAGES,
  MAX_TOOL_LIST_LIMIT,
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
} from "./memory-tools.ts";

/**
 * Parameter schemas for the memory tool surface, built with the package TypeBox.
 *
 * Pi and the MCP server share these schemas. The OMP extension builds its own
 * copies from `ExtensionAPI.typebox`, because OMP validates tool parameters with
 * its host TypeBox build rather than this one.
 */
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

export const namespaceParameters = Type.Object({ namespace: namespaceName });
export const namespaceListParameters = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TOOL_LIST_LIMIT,
      description: memoryFieldDescriptions.namespacesPerPage,
    }),
  ),
  cursor: Type.Optional(Type.String({ description: memoryFieldDescriptions.cursor })),
  order: Type.Optional(
    Type.Union([Type.Literal("id"), Type.Literal("name")], {
      description: memoryFieldDescriptions.sortField,
    }),
  ),
  direction: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description: memoryFieldDescriptions.sortDirection,
    }),
  ),
});
export const rememberParameters = Type.Object({
  ...profileParameters,
  content: Type.String({
    description: memoryFieldDescriptions.rememberContent,
    minLength: 1,
  }),
  sessionId: Type.Optional(
    Type.String({
      description: memoryFieldDescriptions.writeSessionId,
      maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
    }),
  ),
});
export const recallVisibilityParameters = Type.Object({
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
});
export const ingestParameters = Type.Object({
  ...profileParameters,
  messages: Type.Array(
    Type.Object({
      role: Type.Union([Type.Literal("system"), Type.Literal("user"), Type.Literal("assistant")], {
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
    }),
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
});
export const recallParameters = Type.Object({
  ...profileParameters,
  query: Type.String({
    description: memoryFieldDescriptions.recallQuery,
    minLength: 1,
    maxLength: MAX_TOOL_QUERY_CHARACTERS,
  }),
  thinkingLevel: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description: memoryFieldDescriptions.thinkingLevel,
    }),
  ),
  responseLength: Type.Optional(
    Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")], {
      description: memoryFieldDescriptions.responseLength,
    }),
  ),
  referenceDate: Type.Optional(Type.String({ description: memoryFieldDescriptions.referenceDate })),
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
});
export const listParameters = Type.Object({
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
    Type.Union(
      [
        Type.Literal("fact"),
        Type.Literal("event"),
        Type.Literal("instruction"),
        Type.Literal("task"),
      ],
      { description: memoryFieldDescriptions.memoryType },
    ),
  ),
  expand: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TOOL_EXPAND,
      description: memoryFieldDescriptions.listExpand,
    }),
  ),
});
export const getParameters = Type.Object({
  ...profileParameters,
  memoryIds: Type.Array(memoryId, {
    minItems: 1,
    maxItems: MAX_TOOL_EXPAND,
    description: memoryFieldDescriptions.memoryIds,
  }),
});
export const memoryParameters = Type.Object({
  ...profileParameters,
  memoryId,
});
export const sessionParameters = Type.Object({
  ...profileParameters,
  sessionId: Type.String({
    description: memoryFieldDescriptions.sessionToDelete,
    minLength: 1,
    maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
    pattern: MEMORY_ID_PATTERN,
  }),
});
export const summaryParameters = Type.Object({
  ...profileParameters,
  sessionId: Type.Optional(
    Type.String({
      description: memoryFieldDescriptions.summarySessionId,
      maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
    }),
  ),
});
export const profileOnlyParameters = Type.Object(profileParameters);

/** Build the model-facing schemas for either a fixed operational scope or raw administration. */
export function createOperationalMemoryToolSchemas(scoped: boolean) {
  if (!scoped) {
    return {
      rememberParameters,
      recallVisibilityParameters,
      ingestParameters,
      recallParameters,
      listParameters,
      getParameters,
      memoryParameters,
      summaryParameters,
      sessionParameters,
    };
  }

  return {
    rememberParameters: Type.Omit(rememberParameters, ["namespace", "profile", "sessionId"]),
    recallVisibilityParameters: Type.Omit(recallVisibilityParameters, ["namespace", "profile"]),
    ingestParameters: Type.Omit(ingestParameters, ["namespace", "profile", "sessionId"]),
    recallParameters: Type.Omit(recallParameters, ["namespace", "profile"]),
    listParameters: Type.Omit(listParameters, ["namespace", "profile"]),
    getParameters: Type.Omit(getParameters, ["namespace", "profile"]),
    memoryParameters: Type.Omit(memoryParameters, ["namespace", "profile"]),
    summaryParameters: Type.Omit(summaryParameters, ["namespace", "profile"]),
    sessionParameters: Type.Omit(sessionParameters, ["namespace", "profile"]),
  };
}
