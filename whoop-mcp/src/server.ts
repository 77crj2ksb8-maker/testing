import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WhoopClient } from "./whoop/client.js";
import { registerWhoopTools } from "./tools.js";
import type { TokenStore } from "./store/types.js";

/**
 * Builds the MCP server. Transport-agnostic on purpose: the stdio entry point
 * uses it today, and an HTTP entry point for a hosted deployment can use the
 * same call with a different TokenStore.
 */
export function createWhoopServer(store: TokenStore): McpServer {
  const server = new McpServer({
    name: "whoop",
    version: "0.1.0",
  });

  registerWhoopTools(server, new WhoopClient(store));
  return server;
}
