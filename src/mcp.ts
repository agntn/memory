import { createMcpServer as createToolServer } from "@agntn/tools/mcp";
import type { Server } from "@modelcontextprotocol/server";
import { configuredMemoryFields } from "../extensions/shared/memory-fields.ts";
import { createMemoryTools } from "../extensions/shared/memory-tool-definitions.ts";
import {
  claudeCodeMemorySessionId,
  configuredMemoryScope,
  grokMemorySessionId,
} from "../extensions/shared/memory-scope.ts";
import { version } from "./version.ts";

/**
 * The MCP server over the memory tools, scoped and stamped by env, tagging writes with the host session.
 *
 * @returns {Server} An unconnected MCP server; the caller owns its transport and lifecycle.
 * @throws {Error} When the scope variables are half set or invalid, or the fields variable is malformed.
 */
export function createMcpServer(): Server {
  return createToolServer(
    { name: "memory", version },
    createMemoryTools({
      scope: configuredMemoryScope(),
      fields: configuredMemoryFields(),
      writeSession: () => claudeCodeMemorySessionId() ?? grokMemorySessionId(),
    }),
  );
}
