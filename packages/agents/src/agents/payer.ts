/**
 * `bun run agent:payer` — a STANDALONE high-leverage agent whose whole job is to demonstrate the
 * headline x402 Gateway nanopayment: it opens a thin, very-high-leverage position and then answers its
 * margin call every block, streaming a continuous run of sub-cent nanopayments on camera.
 *
 * Why it's separate from the demo fleet (and NOT a 6th `AgentRole`): the orchestrated fleet trades the
 * live markets, where a real oracle barely moves so margin calls — and thus nanopayments — rarely fire.
 * The payer sidesteps that by trading ONE market that runs a gentle synthetic drift (set
 * `MARK_MODE_<PAYER_MARKET>=synthetic` for just that market; the others stay on live marks). At very
 * high leverage with ~zero free collateral, the drift keeps it perpetually below the maintenance line,
 * so it owes a call essentially every block and pays the full amount via the x402 `/pay` route — the
 * continuous nanopayment stream the dashboard's "nanopayments" counter (kind === "margin-call") counts.
 *
 * Custody: reuses the existing standalone Circle wallet (`CIRCLE_WALLET_ID`, the one the example/MCP
 * use) so it needs NO new wallet — override with `CIRCLE_WALLET_ID_PAYER` to give it its own. It must
 * be funded with Arc-testnet USDC (Vault collateral + a Gateway balance for the nanopayments). The
 * Vault deposit + Gateway top-up are done here on first run if needed, signed by the Circle wallet.
 *
 * Env:
 *   CIRCLE_WALLET_ID (or CIRCLE_WALLET_ID_PAYER) — the funded Circle MPC wallet to use.
 *   PAYER_MARKET   (default LINK-PERP) — the market it trades; set MARK_MODE_<that>=synthetic.
 *   PAYER_LEVERAGE (default 25), PAYER_COLLATERAL (default "2"), PAYER_GATEWAY (default "8").
 */

import { type MarketSymbol, SideKick } from "@sidekick/sdk";
import { circleSigner } from "@sidekick/sdk/circle";
import { agentMarket, engineUrl, loadRootEnv } from "../config.ts";
import { directionalPolicy } from "../policies.ts";
import { AgentRunner } from "../runner.ts";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

async function main(): Promise<void> {
  loadRootEnv();

  const apiKey = env("CIRCLE_API_KEY");
  const entitySecret = env("CIRCLE_ENTITY_SECRET");
  const walletId = env("CIRCLE_WALLET_ID_PAYER", env("CIRCLE_WALLET_ID"));
  if (!apiKey || !entitySecret || !walletId) {
    console.error(
      "payer needs Circle creds + a funded wallet: set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and " +
        "CIRCLE_WALLET_ID (or CIRCLE_WALLET_ID_PAYER). Fund that wallet from the Circle Arc-testnet faucet.",
    );
    process.exit(1);
  }

  // The market to trade — set MARK_MODE_<MARKET>=synthetic for JUST this one so it drifts (and keeps
  // calling the payer) while the other markets show live marks.
  const market = (env("PAYER_MARKET") ?? agentMarket()) as MarketSymbol;
  const leverage = Number(env("PAYER_LEVERAGE", "25"));
  const collateral = env("PAYER_COLLATERAL", "2") as string;
  const gatewayUSDC = env("PAYER_GATEWAY", "8") as string;

  const { account, broadcaster } = await circleSigner({ apiKey, entitySecret, walletId });
  const sk = new SideKick({ network: "arc-testnet", account, broadcaster, engineUrl: engineUrl() });

  console.log("── SideKick agent: payer (x402 nanopayment demo) ──");
  console.log(`  address: ${sk.address} (Circle MPC wallet)`);
  console.log(`  market:  ${market}  ·  ${collateral} @ ${leverage}x  ·  Gateway ${gatewayUSDC} USDC`);
  console.log(`  engine:  ${sk.engineUrl}`);
  // NOTE: whether calls fire depends on the ENGINE's mark mode for this market, not this process's env.
  // For a continuous stream, start the engine with MARK_MODE_<MARKET>=synthetic + a gentle
  // SYNTH_DRIFT_PER_BLOCK so this one market drifts (the others can stay on live marks).
  const synthKey = `MARK_MODE_${market.replace(/[^A-Z0-9]/gi, "").toUpperCase()}`;
  console.log(
    `  marks:   continuous nanopayments need the ENGINE running with ${synthKey}=synthetic (+ drift);\n` +
      `           on live marks this market barely moves, so calls fire only in occasional bursts.`,
  );

  // Onboard ONLY what's missing — so re-runs work even after the raw wallet is drained (the prior run's
  // collateral + Gateway balance persist in the venue, they just left the wallet). Deposit Vault
  // collateral only if free collateral can't cover the open (it becomes the position margin ⇒ ~zero
  // free, so the FULL call spills to x402); fund the Gateway only if its balance is below the target.
  const need = BigInt(Math.round(Number(collateral) * 1e6));
  const gwTarget = BigInt(Math.round(Number(gatewayUSDC) * 1e6));
  let free = 0n;
  let gwAvail = 0n;
  try {
    free = await sk.freeCollateral();
  } catch {}
  try {
    gwAvail = (await sk.gatewayBalance()).available;
  } catch {}
  console.log(`  on-chain: free collateral ${(Number(free) / 1e6).toFixed(2)}, Gateway balance ${(Number(gwAvail) / 1e6).toFixed(2)} USDC`);
  const opts: { depositUSDC?: string; gatewayUSDC?: string } = {};
  if (free < need) opts.depositUSDC = collateral;
  if (gwAvail < gwTarget) opts.gatewayUSDC = gatewayUSDC;
  if (opts.depositUSDC || opts.gatewayUSDC) {
    try {
      const res = await sk.onboard(opts);
      if (res.vaultDepositTx) console.log(`  deposited ${collateral} USDC collateral (${res.vaultDepositTx})`);
      if (res.gatewayDepositTx) console.log(`  topped up Gateway to ${gatewayUSDC} USDC (${res.gatewayDepositTx})`);
    } catch (e) {
      // Non-fatal: if the wallet can't fund the top-up but the venue is ALREADY seeded from a prior run,
      // the agent can still open + pay. Only a truly empty venue position will then revert on open.
      console.log(`  ⚠ top-up skipped (wallet low on USDC; using existing on-chain balances): ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  } else {
    console.log("  already funded (free collateral + Gateway balance sufficient) — skipping onboard.");
  }

  // Open the position HERE (not via the runner) so we can then drain free collateral to ~zero. That is
  // the crux of the x402 demo: with zero free collateral the engine cannot auto-settle a call from the
  // Vault, so the FULL call spills to the off-chain x402 path (recorded as `margin-call`, the headline
  // nanopayment) instead of `auto-settle`. A leftover Vault balance would otherwise absorb the call
  // on-chain and nothing would reach x402.
  const view = await sk.getAccount(market);
  if (view.side === "flat") {
    try {
      const mark = (await sk.getState(market))?.mark;
      const tx = await sk.open({ market, side: "long", collateral, leverage, ...(mark ? { mark } : {}) });
      await sk.confirm(tx);
      console.log(`  opened long ${collateral}@${leverage}x (${tx})`);
    } catch (e) {
      console.log(`  ⚠ open failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  } else {
    console.log(`  already holding a ${view.side} position — keeping it.`);
  }

  // Drain any remaining free collateral so x402 is the ONLY way to answer a call.
  try {
    const remaining = await sk.freeCollateral();
    if (remaining > 0n) {
      const amt = (Number(remaining) / 1e6).toFixed(6);
      const tx = await sk.withdraw(amt);
      await sk.confirm(tx);
      console.log(`  drained ${amt} USDC free collateral → calls now settle via x402, not on-chain (${tx})`);
    }
  } catch (e) {
    console.log(`  (could not drain free collateral — some calls may auto-settle on-chain: ${e instanceof Error ? e.message.split("\n")[0] : e})`);
  }

  // A directional long that ALWAYS answers its margin calls (the default). It's already open, so the
  // policy just holds and the runner answers each block's call via x402.
  const policy = directionalPolicy({ id: "payer", side: "long", collateral, leverage, openAt: 0 });
  const runner = new AgentRunner({ sk, policy, market });

  console.log("  starting loop — answering every margin call via x402 (Ctrl-C to stop)\n");
  runner.start();

  const shutdown = () => {
    console.log("\n[agent:payer] stopping…");
    runner.stop();
    sk.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error("agent:payer fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
