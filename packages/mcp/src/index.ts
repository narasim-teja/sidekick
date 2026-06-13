#!/usr/bin/env bun
/**
 * @sidekick/mcp entry point — runs the SideKick MCP server over stdio (the transport MCP clients
 * like Claude Desktop spawn). Reads the trading key + engine URL from the environment, builds the
 * server (all venue tools), and connects.
 *
 * Run directly: `SIDEKICK_PRIVATE_KEY=0x… bun run src/index.ts` (or `bun run mcp` from the root).
 * Configure in an MCP client by pointing it at this file as the command, with `SIDEKICK_PRIVATE_KEY`
 * (and optional `ENGINE_URL`) in the env — see README.md.
 *
 * stdout is reserved for the JSON-RPC protocol; all logs go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, MCP_VERSION } from "./server.ts";

async function main(): Promise<void> {
  const privateKey = process.env.SIDEKICK_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    console.error(
      "[sidekick-mcp] SIDEKICK_PRIVATE_KEY is required (a funded Arc-testnet EOA). " +
        "Set it in the MCP client's env for this server.",
    );
    process.exit(1);
  }
  const engineUrl = process.env.ENGINE_URL;
  const server = buildServer({ privateKey, engineUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs to stderr only — stdout is the JSON-RPC channel.
  console.error(
    `[sidekick-mcp] v${MCP_VERSION} ready on stdio (engine ${engineUrl ?? "http://localhost:8787"})`,
  );
}

main().catch((err) => {
  console.error("[sidekick-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
