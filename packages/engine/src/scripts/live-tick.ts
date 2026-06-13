/**
 * live:tick — run ONE reconciliation tick against live Arc and print the resulting state. The
 * fast way to confirm the engine reads the venue, runs the §4.3 loop off-chain, and triggers a
 * real on-chain `checkpoint`, without leaving the long-running service up.
 *
 * Requires a funded `PRIVATE_KEY` (the checkpoint operator) and the live deployment in shared. Open
 * a position first (e.g. via `live:open`) so the loop has something to reconcile.
 *
 * Run: `bun run live:tick` (optionally `ENGINE_MARKETS=BTC-PERP,ETH-PERP bun run live:tick`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARKET_SYMBOLS, type MarketSymbol } from "@sidekick/shared";
import { EngineService } from "../service.ts";

loadRootEnv();

function loadRootEnv(): void {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../../.env", import.meta.url)), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim();
    }
  } catch {
    /* rely on the ambient env */
  }
}

function markets(): MarketSymbol[] {
  const raw = process.env.ENGINE_MARKETS;
  if (!raw) return ["BTC-PERP"];
  if (raw === "all") return [...MARKET_SYMBOLS];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is MarketSymbol => (MARKET_SYMBOLS as string[]).includes(s));
}

async function main(): Promise<void> {
  const engine = new EngineService({
    markets: markets(),
    checkpointEveryBlocks: Number(process.env.CHECKPOINT_EVERY_BLOCKS ?? "1"),
  });
  console.log("running one live reconciliation tick against Arc…\n");
  const t0 = performance.now();
  const states = await engine.tickOnce();
  console.log(`tick completed in ${(performance.now() - t0).toFixed(0)}ms\n`);

  for (const s of states) {
    console.log(`── ${s.market} (tick ${s.tick}, Arc block ${s.arcBlock}) ──`);
    console.log(`  mark:        $${s.mark} [${s.markProvenance}]`);
    console.log(`  skew:        ${s.skew.toFixed(4)}  smoothSkew: ${s.smoothSkew.toFixed(4)}`);
    console.log(`  fundingRate: ${(s.fundingRate * 100).toFixed(6)}% / period`);
    console.log(`  OI:          long $${s.oiLong} / short $${s.oiShort}`);
    console.log(
      `  pool:        capital $${s.pool.capital}  exposure $${s.pool.exposure} / cap $${s.pool.cap}`,
    );
    for (const p of s.positions) {
      console.log(
        `  position ${p.account.slice(0, 8)}… ${p.side} N $${p.notionalBefore}→$${p.notionalAfter} ` +
          `E $${p.equity} funding ${p.funding} call $${p.call} paid $${p.paid} [${p.outcome}]`,
      );
    }
    if (s.checkpoint)
      console.log(`  ✓ on-chain checkpoint #${s.checkpoint.index}: ${s.checkpoint.txHash}`);
    console.log("");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("live:tick failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
