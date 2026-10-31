/**
 * Serve the MCP server over stdio. The SDK loads here and nowhere else in the CLI.
 *
 * @returns {Promise<void>} Once the transport is connected.
 */
export async function serveMcp(): Promise<void> {
  const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
    import("../mcp.ts"),
    import("@modelcontextprotocol/server/stdio"),
  ]);
  await createMcpServer().connect(new StdioServerTransport());
}
