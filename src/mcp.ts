import { createMcpServer as createToolServer } from "@agntn/tools/mcp";
import type { Server } from "@modelcontextprotocol/server";
import { createMemoryTools } from "../extensions/shared/memory-tool-definitions.ts";
import {
  claudeCodeMemorySessionId,
  configuredMemoryScope,
  grokMemorySessionId,
} from "../extensions/shared/memory-scope.ts";
import { version } from "./version.ts";

/**
 * The MCP server over the memory tools, scoped by env and tagging writes with the host session.
 *
 * @returns {Server} An unconnected MCP server; the caller owns its transport and lifecycle.
 * @throws {Error} When the scope variables are half set or name an invalid namespace or profile.
 */
export function createMcpServer(): Server {
  return createToolServer(
    { name: "memory", version },
    createMemoryTools({
      scope: configuredMemoryScope(),
      writeSession: () => claudeCodeMemorySessionId() ?? grokMemorySessionId(),
    }),
  );
}
