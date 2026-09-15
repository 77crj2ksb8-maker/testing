#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWhoopServer } from "./server.js";
import { FileTokenStore } from "./store/file-store.js";

/**
 * stdio entry point.
 *
 * stdout carries the JSON-RPC stream, so every diagnostic must go to stderr.
 * A stray console.log here corrupts the protocol and the client drops the
 * connection with no useful error.
 */
async function main(): Promise<void> {
  const store = new FileTokenStore();
  const server = createWhoopServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`whoop-mcp ready (credentials: ${store.describe()})`);
}

main().catch((err) => {
  console.error("whoop-mcp failed to start:", err);
  process.exit(1);
});
