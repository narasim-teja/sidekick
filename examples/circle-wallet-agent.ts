/**
 * circle-wallet-agent — the SAME agent as standalone-agent.ts, but its signer is a **Circle
 * developer-controlled wallet** instead of a raw private key. This is the "real external agent"
 * custody path: the key is 2-of-2 MPC held by Circle and never materializes in this process, yet the
 * agent trades AND answers margin calls (gas-free Circle Nanopayments) exactly the same way — because
 * SideKick takes a signer, not a secret.
 *
 * What it proves end-to-end:
 *   1. circleAccount({ walletId, apiKey, entitySecret }) → a viem account backed by Circle MPC.
 *   2. new SideKick({ account }) — no `privateKey` anywhere.
 *   3. discover → onboard → open → answer-margin-call (signer-only Gateway path) → close.
 *
 * Run:
 *   export CIRCLE_API_KEY=...           # Circle Console API key
 *   export CIRCLE_ENTITY_SECRET=...     # 32-byte entity secret (a SECRET — do not log/commit)
 *   export CIRCLE_WALLET_ID=...         # a developer-controlled wallet, funded with Arc-testnet USDC
 *   export ENGINE_URL=http://localhost:8787
 *   bun run examples/circle-wallet-agent.ts --collateral 10 --leverage 5 --blocks 20
 *
 * No Circle wallet yet? Create one (EOA on ARC-TESTNET) with the Circle SDK's createWallets, fund the
 * printed address from the Circle Arc-testnet USDC faucet, then set CIRCLE_WALLET_ID and re-run.
 */

import { type MarketSymbol, SideKick, type VenueMarketDescriptor } from "@sidekick/sdk";
import { circleAccount } from "@sidekick/sdk/circle";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = i !== -1 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}

function pickMarket(markets: VenueMarketDescriptor[]): VenueMarketDescriptor {
  const live = markets.find((m) => m.live?.markProvenance?.endsWith("-live"));
  const chosen = live ?? markets[0];
  if (!chosen) throw new Error("the venue exposes no markets");
  return chosen;
}

async function main(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletId = process.env.CIRCLE_WALLET_ID;
  if (!apiKey || !entitySecret || !walletId) {
    console.error(
      "Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WALLET_ID (a funded Arc-testnet Circle wallet).",
    );
    process.exit(1);
  }
  const engineUrl = process.env.ENGINE_URL ?? "http://localhost:8787";
  const collateral = arg("collateral", "10");
  const leverage = Number(arg("leverage", "5"));
  const maxBlocks = Number(arg("blocks", "20"));

  // 0) CUSTODY — a viem account backed by Circle MPC. No raw key in this process.
  const account = await circleAccount({ walletId, apiKey, entitySecret });
  const sk = new SideKick({ network: "arc-testnet", account, engineUrl });
  console.log(`agent ${sk.address} (Circle developer-controlled wallet ${walletId})`);

  // 1) DISCOVER
  const venue = await sk.venue();
  const market = pickMarket(venue.markets);
  const symbol = market.symbol as MarketSymbol;
  console.log(
    `\nvenue "${venue.name}" on chain ${venue.chainId}; trading ${symbol} — ` +
      `mark $${market.live?.mark ?? "?"} (${market.live?.markProvenance})`,
  );

  // 2) ONBOARD — Vault collateral + a Gateway balance for the gas-free margin-call Nanopayments.
  const vaultUSDC = (Number(collateral) * 2).toString();
  console.log(`\nonboarding: ${vaultUSDC} USDC collateral + 5 USDC Gateway…`);
  await sk.onboard({ depositUSDC: vaultUSDC, gatewayUSDC: "5" });
  console.log(`  free collateral: ${(Number(await sk.freeCollateral()) / 1e6).toFixed(2)} USDC`);

  // 3–6) OBSERVE → DECIDE → ACT → SETTLE for a few blocks, then close out.
  console.log(`\nlive loop on ${symbol} (${maxBlocks} blocks)…\n`);
  let blocks = 0;
  let acting = false;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const unsubscribe = sk.on("block", (state) => {
    if (state.market !== symbol) return;
    if (acting) return;
    acting = true;
    void (async () => {
      try {
        blocks += 1;
        // SETTLE — answer any margin call as a gas-free Nanopayment, signed via Circle MPC (no raw key).
        if ((await sk.owed(symbol)) > 0n) {
          const r = await sk.answerMarginCall(symbol);
          console.log(
            `  block ${blocks}: margin call → ${r.settled ? `paid ${r.amount} ✓` : r.reason}`,
          );
        }
        const me = await sk.getAccount(symbol);
        if (blocks >= maxBlocks) {
          if (me.side !== "flat") await sk.confirm(await sk.close(symbol));
          unsubscribe();
          sk.disconnect();
          done();
          return;
        }
        const want = state.smoothSkew > 0.05 ? "short" : state.smoothSkew < -0.05 ? "long" : null;
        if (me.side === "flat" && want) {
          await sk.confirm(await sk.open({ market: symbol, side: want, collateral, leverage }));
          console.log(
            `  block ${blocks}: OPEN ${want} ${collateral}@${leverage}x (signed by Circle MPC)`,
          );
        } else {
          console.log(`  block ${blocks}: hold ${me.side} · equity ${me.equity}`);
        }
      } catch (err) {
        console.error(
          `  block ${blocks}: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
        );
      } finally {
        acting = false;
      }
    })();
  });

  await finished;
  console.log("\ndone — Circle-wallet agent closed out, stream disconnected.");
  process.exit(0);
}

main().catch((err) => {
  console.error("circle-wallet-agent failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
