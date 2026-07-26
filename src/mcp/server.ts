/**
 * Empty stdio MCP server (phase 0). The three QQ tools arrive in phase 5;
 * no QQ-writing tool will ever be registered here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const SERVER_NAME = "qq-message-monitor";

export function createMcpServer(version: string): McpServer {
  return new McpServer({ name: SERVER_NAME, version });
}

export async function connectStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
