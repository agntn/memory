/**
 * Serve the MCP server over stdio in the harness's directory. The SDK loads here and nowhere else.
 *
 * @returns {Promise<void>} Once the transport is connected.
 */
export async function serveMcp(): Promise<void> {
  const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
    import("../mcp.ts"),
    import("@modelcontextprotocol/server/stdio"),
  ]);
  await createMcpServer({ cwd: process.cwd() }).connect(new StdioServerTransport());
}
