/**
 * Serve the MCP server over stdio in the harness's directory, to 2025 and 2026 clients alike.
 * The SDK loads here and nowhere else.
 *
 * @returns {Promise<void>} Once the server listens.
 * @throws {Error} When the scope or fields env is malformed.
 */
export async function serveMcp(): Promise<void> {
  const [{ createMcpServer }, { serveStdio }] = await Promise.all([
    import("../mcp.ts"),
    import("@modelcontextprotocol/server/stdio"),
  ]);
  const options = { cwd: process.cwd() };
  /** Built up front, so a bad env still fails the start. */
  let first: ReturnType<typeof createMcpServer> | undefined = createMcpServer(options);
  serveStdio(() => {
    const server = first ?? createMcpServer(options);
    first = undefined;
    return server;
  });
}
