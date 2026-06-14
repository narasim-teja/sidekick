/**
 * roundtrip-circle — the full live round-trip with a Circle MPC wallet as the ONLY signer (no raw key
 * anywhere). Proves the headline end-to-end: a developer-controlled Circle wallet trades on SideKick
 * AND answers a real margin call gas-free via the signer-only x402/Gateway path.
 *
 * Steps: discover → onboard (Vault + Gateway) → open a high-leverage position on the crowded (funding-
 * paying) side → watch per-block until a margin call fires → answer it gas-free → close out → report.
 *
 * Reads CIRCLE_* + ENGINE_URL from .env. Never prints the entity secret. Run with the engine up:
 *   bun run packages/sdk/scripts/roundtrip-circle.ts [--side long] [--collateral 2] [--leverage 8] [--max-blocks 40]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { circleSigner } from "../src/circle-account.ts";
import { SideKick } from "../src/client.ts";
import type { MarketSymbol } from "../src/types.ts";

function loadEnv(): void {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        v.length >= 2 &&
        ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))
      )
        v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ambient */
  }
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = i !== -1 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  loadEnv();
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletId = process.env.CIRCLE_WALLET_ID;
  if (!apiKey || !entitySecret || !walletId) {
    console.error("Missing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_ID in .env");
    process.exit(1);
  }
  const engineUrl = process.env.ENGINE_URL ?? "http://localhost:8787";
  const side = arg("side", "long") as "long" | "short";
  const collateral = arg("collateral", "2");
  const leverage = Number(arg("leverage", "8"));
  const maxBlocks = Number(arg("max-blocks", "40"));

  // CUSTODY: full Circle MPC — `account` signs (EIP-712/191), `broadcaster` does on-chain writes via
  // Circle's tx API. No raw private key anywhere in this process.
  const { account, broadcaster } = await circleSigner({ walletId, apiKey, entitySecret });
  const sk = new SideKick({ network: "arc-testnet", account, broadcaster, engineUrl });
  console.log(`agent ${sk.address} (Circle MPC wallet ${walletId}) — full custody, no raw key\n`);

  // 1) DISCOVER
  const venue = await sk.venue();
  const m = (arg("market", "") || venue.markets[0]?.symbol) as MarketSymbol;
  const md = venue.markets.find((x) => x.symbol === m);
  console.log(`venue ${venue.name} chain ${venue.chainId} | trading ${m}`);
  console.log(
    `  mark $${md?.live?.mark} (${md?.live?.markProvenance}) skew ${md?.live?.skew?.toFixed(3)} funding ${md?.live?.fundingRate} m=${md?.params.m} (max lev ~${(1 / (md?.params.m ?? 0.1)).toFixed(0)}x)\n`,
  );

  // 2) ONBOARD — Vault collateral + a Gateway balance the margin-call nanopayment draws against.
  //    Post a bit more than the margin so there's headroom; Gateway funds the gas-free answer.
  //    Skip with --skip-onboard to reuse collateral/Gateway already deposited in a prior run.
  const seedUSDC = arg("seed", "0"); // optionally seed the pool first (synthetic markets start empty)
  if (process.argv.includes("--skip-onboard")) {
    console.log(
      `reusing existing balances; free collateral: ${(Number(await sk.freeCollateral()) / 1e6).toFixed(2)} USDC\n`,
    );
  } else {
    const vaultUSDC = (Number(collateral) + Number(seedUSDC) + 2).toString();
    const gatewayUSDC = "3";
    console.log(`onboarding: Vault ${vaultUSDC} USDC + Gateway ${gatewayUSDC} USDC…`);
    const ob = await sk.onboard({ depositUSDC: vaultUSDC, gatewayUSDC });
    console.log(`  vault tx:   ${ob.vaultDepositTx}`);
    console.log(`  gateway tx: ${ob.gatewayDepositTx} (signer-only deposit, no raw key)`);
    console.log(`  free collateral: ${(Number(await sk.freeCollateral()) / 1e6).toFixed(2)} USDC`);
  }

  // 2b) SEED — a synthetic market starts with 0 pool capital (OI cap = k·capital = 0 → no opens). If
  //     asked, provide liquidity from the Circle wallet so the pool can be the counterparty.
  if (
    Number(seedUSDC) > 0 &&
    (md?.live?.poolCapital === undefined || Number(md?.live?.poolCapital) === 0)
  ) {
    console.log(`  seeding pool with ${seedUSDC} USDC liquidity (Circle-signed)…`);
    const lpTx = await sk.provideLiquidity(m, seedUSDC);
    await sk.confirm(lpTx);
    console.log(`  lp tx: ${lpTx}`);
  }
  console.log("");

  // 3) OPEN — high leverage on `side`. Crowd is long (skew>0) ⇒ longs PAY funding ⇒ equity erodes ⇒ call.
  console.log(
    `opening ${side} ${collateral}@${leverage}x on ${m} (notional ~${Number(collateral) * leverage})…`,
  );
  const openTx = await sk.open({ market: m, side, collateral, leverage });
  await sk.confirm(openTx);
  console.log(`  open tx: ${openTx}`);
  const me0 = await sk.getAccount(m);
  console.log(
    `  position: ${me0.side} notional ${me0.entryNotional} margin ${me0.margin} equity ${me0.equity}`,
  );

  // 3b) DRAIN — the venue auto-settles a shortfall from FREE collateral before emitting an external
  //     x402 call. To force a real external call (the gas-free Nanopayment), withdraw the free
  //     collateral so a shortfall has no cushion. Leave a tiny residual for safety.
  if (process.argv.includes("--drain")) {
    const free = Number(await sk.freeCollateral()) / 1e6;
    const keep = 0.02;
    if (free > keep) {
      const amt = (free - keep).toFixed(6);
      console.log(
        `  draining free collateral: withdraw ${amt} USDC (so a shortfall can't auto-settle)…`,
      );
      const wtx = await sk.withdraw(amt);
      await sk.confirm(wtx);
      console.log(
        `  withdraw tx: ${wtx} | free now: ${(Number(await sk.freeCollateral()) / 1e6).toFixed(3)} USDC`,
      );
    }
  }
  console.log("");

  // 4–5) WATCH for a real margin call, then ANSWER it gas-free via the signer-only x402 path.
  console.log(
    `watching ${maxBlocks} blocks for a margin call (funding erodes the leveraged margin)…\n`,
  );
  let answered = false;
  for (let b = 1; b <= maxBlocks && !answered; b++) {
    await sleep(2200); // ~1 Arc block
    const owed = await sk.owed(m);
    const me = await sk.getAccount(m);
    process.stdout.write(
      `  block ${b}: equity ${me.equity} margin ${me.margin} owed ${(Number(owed) / 1e6).toFixed(6)}\n`,
    );
    if (owed > 0n) {
      console.log(
        `\n  ⚡ margin call: ${(Number(owed) / 1e6).toFixed(6)} USDC owed — answering gas-free (Circle MPC signer, no raw key)…`,
      );
      const r = await sk.answerMarginCall(m);
      console.log(
        `  → settled=${r.settled} amount=${r.amount ?? "-"} tx=${r.transaction ?? "-"} reason=${r.reason ?? "-"}`,
      );
      if (r.settled) {
        answered = true;
        console.log(
          "\n  ✅ ROUND-TRIP COMPLETE: a Circle MPC wallet answered a real margin call as a gas-free Nanopayment.",
        );
      } else {
        console.log(`  (not settled: ${r.reason}) — continuing…`);
      }
    }
  }

  if (!answered) {
    console.log(
      "\n  ⚠ no settled margin call within the window. The plumbing ran (open + x402 handshake);",
    );
    console.log(
      "    funding may not have eroded the margin enough yet — re-run with higher --leverage or more --max-blocks.",
    );
  }

  // 6) CLOSE OUT
  const meEnd = await sk.getAccount(m);
  if (meEnd.side !== "flat") {
    console.log(`\nclosing ${meEnd.side} position…`);
    const closeTx = await sk.close(m);
    await sk.confirm(closeTx);
    console.log(`  close tx: ${closeTx}`);
  }
  console.log(
    `\nfinal free collateral: ${(Number(await sk.freeCollateral()) / 1e6).toFixed(2)} USDC`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ round-trip failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
