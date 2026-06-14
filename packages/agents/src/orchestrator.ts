/**
 * `bun run demo` — the scripted demo orchestrator (Doc 2 §4.2, Doc 3 §11). It runs the full
 * long + short + funding-strategy + MM + dark scenario against the live engine, with narration, so
 * the dashboard (Phase 7) shows the per-block loop proving Claim 1: agents doing things a human venue
 * cannot host. Seeded keys + fixed `scenario.ts` params make it reproducible — the same run every
 * time, which doubles as the Doc 3 §11 backup if the live demo hiccups.
 *
 * Flow:
 *   1. (`--fund`) onboard the agents first (delegates to the fund script's logic) — optional; skip if
 *      you already ran `bun run fund`.
 *   2. Ensure the market pool is seeded — a 0-capital pool admits no trades (Layer-2 cap = k·capital),
 *      so the `funding`-role Circle wallet provides liquidity if the pool is thin.
 *   3. Build all five agents (each signing through its own Circle MPC wallet) and start their loops on
 *      the shared per-block WS stream.
 *   4. Narrate: print a compact per-block line (mark, skew, funding rate, pool exposure vs cap) plus
 *      each agent's action, so the scenario reads clearly in the terminal alongside the dashboard.
 *
 * Requires the engine running (`bun run dev` in packages/engine) and the agents funded.
 */

import {
  AGENT_ROLES,
  type AgentRole,
  formatUsdc,
  type MarketBlockState,
  parseUsdc,
} from "@sidekick/sdk";
import { POOL_ABI } from "@sidekick/sdk/abis";
import { ARC_TESTNET_DEPLOYMENT, arcTestnet, marketDeployment, rpcUrl } from "@sidekick/shared";
import { createPublicClient, http } from "viem";
import { agentMarket, circleSkForRole, engineUrl, hasFlag, loadRootEnv } from "./config.ts";
import { type BuiltAgent, buildAgent } from "./factory.ts";
import type { AgentStep } from "./runner.ts";
import { SCENARIO } from "./scenario.ts";

/** The role whose Circle wallet seeds the pool (it's funded as part of the fleet). */
const POOL_SEED_ROLE: AgentRole = "funding";

/** Liquidity (decimal USDC) the funder seeds the pool with if it is thin (so opens are admitted). */
const POOL_SEED_USDC = process.env.POOL_SEED_USDC ?? "12";

async function ensurePoolSeeded(market: ReturnType<typeof agentMarket>): Promise<void> {
  const chain = arcTestnet();
  const pub = createPublicClient({ chain, transport: http(rpcUrl()) });
  const pool = marketDeployment(ARC_TESTNET_DEPLOYMENT, market).pool;
  const capital = (await pub.readContract({
    address: pool,
    abi: POOL_ABI,
    functionName: "capital",
  })) as bigint;
  if (capital >= parseUsdc(POOL_SEED_USDC)) {
    console.log(`  pool ${market} already seeded (capital ${formatUsdc(capital)} USDC)`);
    return;
  }
  // Seed from the funding-role Circle wallet (funded as part of the fleet) — no raw key.
  const sk = await circleSkForRole(POOL_SEED_ROLE);
  console.log(
    `  seeding pool ${market} with ${POOL_SEED_USDC} USDC from the ${POOL_SEED_ROLE} Circle wallet (${sk.address})…`,
  );
  // The seeding wallet must have free collateral in the Vault first.
  const free = await sk.freeCollateral();
  if (free < parseUsdc(POOL_SEED_USDC)) {
    const dep = await sk.deposit(POOL_SEED_USDC);
    await sk.confirm(dep);
  }
  const tx = await sk.provideLiquidity(market, POOL_SEED_USDC);
  const ok = await sk.confirm(tx);
  console.log(ok ? `  ✓ pool seeded (${tx})` : `  ✗ pool seed reverted (${tx})`);
}

/** Compact per-block narration line. */
function narrate(state: MarketBlockState): string {
  const expo = Number(state.pool.exposure);
  const cap = Number(state.pool.cap);
  const pct = cap > 0 ? ((expo / cap) * 100).toFixed(0) : "0";
  return (
    `[blk ${state.tick}] ${state.market} $${state.mark} ` +
    `skew ${state.skew.toFixed(3)} funding ${(state.fundingRate * 100).toFixed(4)}%/T ` +
    `pool ${formatUsdc(BigInt(Math.round(expo * 1e6)))}/${formatUsdc(BigInt(Math.round(cap * 1e6)))} (${pct}%) ` +
    `OI L/S ${state.oiLong}/${state.oiShort}`
  );
}

async function main(): Promise<void> {
  loadRootEnv();
  const market = agentMarket();

  console.log("════ SideKick demo orchestrator (Doc 3 §11) ════");
  console.log(`  market: ${market} · engine: ${engineUrl()}`);
  console.log("  fleet: Circle MPC wallets (no raw keys)");
  console.log("");

  // 1. Optional fund pass.
  if (hasFlag("fund")) {
    console.log("  --fund: onboarding agents first…");
    await import("./scripts/fund.ts").catch((err) => {
      console.error("  fund step failed:", err);
    });
    // fund.ts calls process.exit, so when --fund is used run it as a separate step (bun run fund).
  }

  // 2. Seed the pool so opens are admitted.
  await ensurePoolSeeded(market);
  console.log("");

  // 3. Build + start all five agents on the shared stream.
  const onStep = (role: AgentRole, step: AgentStep) => {
    if (step.action.kind !== "none" || step.answered) {
      const parts: string[] = [`  · ${role}`];
      if (step.action.kind === "open")
        parts.push(`open ${step.action.side} ${step.action.collateral}@${step.action.leverage}x`);
      if (step.action.kind === "close") parts.push("close");
      if (step.tx) parts.push(`tx ${step.tx.slice(0, 10)}…`);
      if (step.answered?.settled) parts.push(`answered ${step.answered.amount} USDC (x402)`);
      if (step.note) parts.push(`(${step.note})`);
      console.log(parts.join(" "));
    }
  };

  const built: BuiltAgent[] = await Promise.all(
    AGENT_ROLES.map((role) => buildAgent(role, { market, onStep })),
  );
  console.log("  agents:");
  for (const a of built) {
    const p = SCENARIO[a.role];
    console.log(
      `    ${a.role.padEnd(8)} ${a.address}  stage@blk${p.stage} ${p.collateral}@${p.leverage}x`,
    );
  }
  console.log("\n  starting loops — narration below (Ctrl-C to stop)\n");

  // Narrate the market each block off one agent's stream (they all share the engine WS).
  const narrator = built[0];
  if (narrator) {
    narrator.sk.on("block", (state) => {
      if (state.market === market) console.log(narrate(state));
    });
  }

  for (const a of built) a.runner.start();

  const shutdown = () => {
    console.log("\n[demo] stopping all agents…");
    for (const a of built) {
      a.runner.stop();
      a.sk.disconnect();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error("demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
