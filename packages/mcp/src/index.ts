#!/usr/bin/env bun

/**
 * @sidekick/mcp entry point — runs the SideKick MCP server over stdio (the transport MCP clients
 * like Claude Desktop spawn). Resolves the trading signer from the environment, builds the server
 * (all venue tools), and connects.
 *
 * Signer resolution: the server signs through a **Circle developer-controlled wallet** (MPC custody —
 * no raw key in the process; trades + answers margin calls), configured via `CIRCLE_API_KEY` +
 * `CIRCLE_ENTITY_SECRET` + `CIRCLE_WALLET_ID`. There is no raw-key fallback. Optional `ENGINE_URL`
 * (default `http://localhost:8787`).
 *
 * Run directly: `CIRCLE_API_KEY=… CIRCLE_ENTITY_SECRET=… CIRCLE_WALLET_ID=… bun run src/index.ts`.
 * Configure the same env in an MCP client — see README.md.
 *
 * stdout is reserved for the JSON-RPC protocol; all logs go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SideKick } from "@sidekick/sdk";
import { circleSigner } from "@sidekick/sdk/circle";
import { buildServer, MCP_VERSION } from "./server.ts";

async function main(): Promise<void> {
  const engineUrl = process.env.ENGINE_URL;
  const { CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID } = process.env;

  if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET || !CIRCLE_WALLET_ID) {
    console.error(
      "[sidekick-mcp] no signer configured. Set a Circle developer-controlled wallet " +
        "(CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + CIRCLE_WALLET_ID) in the MCP client's env. " +
        "Create one: cd packages/sdk && bun run circle:wallets --name sidekick-mcp --count 1.",
    );
    process.exit(1);
  }

  // Circle developer-controlled wallet: MPC custody, no raw key in this process.
  const { account, broadcaster } = await circleSigner({
    apiKey: CIRCLE_API_KEY,
    entitySecret: CIRCLE_ENTITY_SECRET,
    walletId: CIRCLE_WALLET_ID,
  });
  const sk = new SideKick({ network: "arc-testnet", account, broadcaster, engineUrl });
  const server = buildServer({ client: sk });
  const signerLabel = `Circle wallet ${sk.address}`;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs to stderr only — stdout is the JSON-RPC channel.
  console.error(
    `[sidekick-mcp] v${MCP_VERSION} ready on stdio (signer: ${signerLabel}, engine ${engineUrl ?? "http://localhost:8787"})`,
  );
}

main().catch((err) => {
  console.error("[sidekick-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
