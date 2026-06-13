/**
 * @sidekick/engine — the off-chain per-block loop, live against Arc (Phase 3).
 *
 *   Layer A (compute): each ~2s Arc block, re-mark every position, recompute skew + funding (§4.1),
 *     check solvency and decrement (§4.2) in the §4.3 order — in FIXED POINT, so the off-chain
 *     prediction equals the on-chain `PerpEngine.checkpoint` it then triggers.
 *   Layer B (value transfer): the funding + margin-call stream as EIP-3009/x402 nanopayment
 *     authorizations against Gateway unified balances (the engine is the x402 seller).
 *
 * The pure math is in `./fixed` (mirrors the Solidity libs; parity-tested), the chain I/O in
 * `./chain`, the loop in `./loop`, Layer B in `./payments`, and the service wiring in `./service`.
 *
 * Run the live service: `bun run dev` (or `bun run src/index.ts`) — requires a funded `PRIVATE_KEY`
 * (the checkpoint operator) and the live deployment in `@sidekick/shared`.
 *
 * The Phase-1 simulation still lives in `./sim` (`bun run sim`) — float, for the constants sweep.
 *
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 3 (live engine)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MarketSymbol } from "@sidekick/shared";
import { MARKET_SYMBOLS } from "@sidekick/shared";
import { type EngineConfig, EngineService } from "./service.ts";

export const ENGINE_VERSION = "0.3.1" as const;

export * as fixed from "./fixed/index.ts";
export type { EngineConfig } from "./service.ts";
export { EngineService } from "./service.ts";
export * from "./state.ts";

/** Read which markets to run from env (`ENGINE_MARKETS=BTC-PERP,ETH-PERP`), defaulting to BTC. */
function marketsFromEnv(env: Record<string, string | undefined>): MarketSymbol[] {
  const raw = env.ENGINE_MARKETS;
  if (!raw) return ["BTC-PERP"];
  if (raw === "all") return [...MARKET_SYMBOLS];
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is MarketSymbol => (MARKET_SYMBOLS as string[]).includes(s));
  return parsed.length > 0 ? parsed : ["BTC-PERP"];
}

/**
 * Load the repo-root `.env` into process.env without overwriting existing values. Bun auto-loads
 * `.env` from CWD, but the engine is launched per-package, so we read the root file explicitly
 * (same approach as the spike runners).
 */
function loadRootEnv(): void {
  try {
    const path = fileURLToPath(new URL("../../../.env", import.meta.url));
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // no root .env — rely on the ambient environment
  }
}

/** Bootstrap: build the engine, start the loop, and serve the Hono app + WebSocket stream. */
async function main(): Promise<void> {
  loadRootEnv();
  const env = process.env;
  const config: EngineConfig = {
    markets: marketsFromEnv(env),
    checkpointEveryBlocks: Number(env.CHECKPOINT_EVERY_BLOCKS ?? "1"),
    env,
  };
  const port = Number(env.ENGINE_PORT ?? "8787");

  const engine = new EngineService(config);

  // Bridge per-block state to all open WebSocket clients.
  const sockets = new Set<{ send: (data: string) => void }>();
  engine.subscribe((state) => {
    const payload = JSON.stringify({ type: "block", state });
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        sockets.delete(ws);
      }
    }
  });

  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return undefined;
        return new Response("WebSocket upgrade failed", { status: 426 });
      }
      return engine.app.fetch(req);
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        // Send the current snapshot immediately so a new subscriber isn't blank until the next block.
        ws.send(JSON.stringify({ type: "hello", version: ENGINE_VERSION }));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {
        /* the stream is push-only; ignore client messages */
      },
    },
  });

  console.log(`[engine] v${ENGINE_VERSION} listening on http://localhost:${server.port}`);
  console.log(`[engine] WebSocket stream at ws://localhost:${server.port}/ws`);
  await engine.start();

  const shutdown = () => {
    console.log("\n[engine] shutting down…");
    engine.stop();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only auto-start when run directly (not when imported for tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error("[engine] fatal:", err);
    process.exit(1);
  });
}
