import { createMcpServer as createToolServer } from "@agntn/tools/mcp";
import type { Server } from "@modelcontextprotocol/server";
import { hostMemoryFields } from "../extensions/shared/memory-fields.ts";
import { projectRepository } from "../extensions/shared/memory-project-scope.ts";
import { createMemoryTools } from "../extensions/shared/memory-tool-definitions.ts";
import {
  claudeCodeMemorySessionId,
  configuredMemoryScope,
  detectedMemoryHarness,
  grokMemorySessionId,
} from "../extensions/shared/memory-scope.ts";
import { version } from "./version.ts";

/** How one MCP server binds the place it runs in. */
export interface McpServerOptions {
  /** Directory whose git remote names `repository`. Leave it out on a shared host. */
  readonly cwd?: string;
}

/**
 * The MCP server over the memory tools, scoped and stamped by env, tagging writes with the host session.
 *
 * @param options - The working directory of the harness that started the server, if it has one.
 * @returns {Server} An unconnected MCP server; the caller owns its transport and lifecycle.
 * @throws {Error} When the scope variables are half set or invalid, or the fields variable is malformed.
 */
export function createMcpServer(options: McpServerOptions = {}): Server {
  const { cwd } = options;
  return createToolServer(
    { name: "memory", version },
    createMemoryTools({
      scope: configuredMemoryScope(),
      fields: hostMemoryFields(detectedMemoryHarness()),
      ...(cwd === undefined ? {} : { repository: () => projectRepository(cwd) }),
      writeSession: () => claudeCodeMemorySessionId() ?? grokMemorySessionId(),
    }),
  );
}
