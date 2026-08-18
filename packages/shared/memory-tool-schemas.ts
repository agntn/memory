import { Type } from "typebox";
import {
  ISO_INSTANT_PATTERN,
  MAX_TOOL_INGEST_MESSAGES,
  MAX_TOOL_LIST_LIMIT,
  MAX_TOOL_MESSAGE_CHARACTERS,
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_ID_PATTERN,
  MEMORY_NAME_PATTERN,
} from "./memory-tools.ts";

/**
 * Parameter schemas for the memory tool surface, built with the package TypeBox.
 *
 * Pi and the MCP server share these schemas. The OMP extension builds its own
 * copies from `ExtensionAPI.typebox`, because OMP validates tool parameters with
 * its host TypeBox build rather than this one.
 */
const namespaceName = Type.String({
  description:
    "Cloudflare Agent Memory namespace. The service accepts lowercase letters, numbers, and internal hyphens only. List existing ones with memory_namespace_list.",
  minLength: 1,
  maxLength: MAX_TOOL_NAMESPACE_CHARACTERS,
  pattern: MEMORY_NAME_PATTERN,
});
const profileParameters = {
  namespace: namespaceName,
  profile: Type.String({
    description:
      "Memory profile inside the namespace. The service accepts lowercase letters, numbers, and internal hyphens only. A profile starts existing on its first write; there is no profile listing.",
    minLength: 1,
    maxLength: MAX_TOOL_PROFILE_CHARACTERS,
    pattern: MEMORY_NAME_PATTERN,
  }),
};
const sessionIdDescription =
  "Session identifier grouping related memories. It is the only unit memory_delete_session can remove, so pass one whenever the memories may need removing together.";
const cursorDescription =
  "Cursor copied from the previous response. A response without a cursor was the last page.";

export const namespaceParameters = Type.Object({ namespace: namespaceName });
export const namespaceListParameters = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TOOL_LIST_LIMIT,
      description: `Namespaces per page, 1-${MAX_TOOL_LIST_LIMIT}.`,
    }),
  ),
  cursor: Type.Optional(Type.String({ description: cursorDescription })),
  order: Type.Optional(
    Type.Union([Type.Literal("id"), Type.Literal("name")], { description: "Sort field." }),
  ),
  direction: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "Sort direction." }),
  ),
});
export const rememberParameters = Type.Object({
  ...profileParameters,
  content: Type.String({
    description:
      "Memory content to store. The service writes it verbatim, assigns the memory type itself, and publishes no size limit for this field.",
    minLength: 1,
  }),
  sessionId: Type.Optional(
    Type.String({ description: sessionIdDescription, maxLength: MAX_TOOL_SESSION_ID_CHARACTERS }),
  ),
});
export const ingestParameters = Type.Object({
  ...profileParameters,
  messages: Type.Array(
    Type.Object({
      role: Type.Union([Type.Literal("system"), Type.Literal("user"), Type.Literal("assistant")], {
        description: "Who produced the message.",
      }),
      content: Type.String({
        description: "Message text.",
        minLength: 1,
        maxLength: MAX_TOOL_MESSAGE_CHARACTERS,
      }),
      timestamp: Type.Optional(
        Type.String({
          description:
            "When the message was sent, as an ISO-8601 instant with an explicit offset, for example 2026-08-17T10:00:00Z.",
          pattern: ISO_INSTANT_PATTERN,
        }),
      ),
    }),
    {
      minItems: 1,
      maxItems: MAX_TOOL_INGEST_MESSAGES,
      description: "Conversation messages in the order they were exchanged.",
    },
  ),
  sessionId: Type.Optional(
    Type.String({ description: sessionIdDescription, maxLength: MAX_TOOL_SESSION_ID_CHARACTERS }),
  ),
});
export const recallParameters = Type.Object({
  ...profileParameters,
  query: Type.String({
    description: "Natural-language recall query.",
    minLength: 1,
    maxLength: MAX_TOOL_QUERY_CHARACTERS,
  }),
  thinkingLevel: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description:
        "Retrieval breadth. Higher levels search more candidates and take longer. Defaults to low.",
    }),
  ),
  responseLength: Type.Optional(
    Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")], {
      description: "Requested length of the prose answer. Defaults to medium.",
    }),
  ),
  referenceDate: Type.Optional(
    Type.String({
      description: "ISO-8601 date the service treats as now when the query is time-relative.",
    }),
  ),
});
export const listParameters = Type.Object({
  ...profileParameters,
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TOOL_LIST_LIMIT,
      description: `Memories per page, 1-${MAX_TOOL_LIST_LIMIT}.`,
    }),
  ),
  cursor: Type.Optional(Type.String({ description: cursorDescription })),
  sessionId: Type.Optional(
    Type.String({
      description: "Return only memories from this session.",
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
      { description: "Filter by the type the service assigned when the memory was written." },
    ),
  ),
});
export const memoryParameters = Type.Object({
  ...profileParameters,
  memoryId: Type.String({
    description: "Exact memory identifier from memory_list, memory_remember, or memory_recall.",
    minLength: 1,
    pattern: MEMORY_ID_PATTERN,
  }),
});
export const sessionParameters = Type.Object({
  ...profileParameters,
  sessionId: Type.String({
    description: "Exact session identifier. Every memory carrying it is removed.",
    minLength: 1,
    maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
    pattern: MEMORY_ID_PATTERN,
  }),
});
export const summaryParameters = Type.Object({
  ...profileParameters,
  sessionId: Type.Optional(
    Type.String({
      description: "Summarize only this session instead of the whole profile.",
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
      ingestParameters,
      recallParameters,
      listParameters,
      memoryParameters,
      summaryParameters,
      sessionParameters,
    };
  }

  return {
    rememberParameters: Type.Omit(rememberParameters, ["namespace", "profile", "sessionId"]),
    ingestParameters: Type.Omit(ingestParameters, ["namespace", "profile", "sessionId"]),
    recallParameters: Type.Omit(recallParameters, ["namespace", "profile"]),
    listParameters: Type.Omit(listParameters, ["namespace", "profile"]),
    memoryParameters: Type.Omit(memoryParameters, ["namespace", "profile"]),
    summaryParameters: Type.Omit(summaryParameters, ["namespace", "profile"]),
    sessionParameters: Type.Omit(sessionParameters, ["namespace", "profile"]),
  };
}
