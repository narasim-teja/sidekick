/**
 * standalone-agent — a complete external trading agent in one file, using ONLY `@sidekick/sdk`.
 *
 * This is the "a stranger joins the venue and trades" path: nothing here depends on the demo seed,
 * the orchestrator, or any internal package. An outside developer copies this file, sets two env
 * vars, and has an autonomous agent that discovers the venue, onboards, opens a position, reacts to
 * live state every block, answers its own margin calls gas-free, and closes out — the full lifecycle.
 *
 * What it shows, end to end:
 *   1. DISCOVER  — `sk.venue()` self-configures the agent (markets, params, addresses, cadence) with
 *                  zero prior knowledge. The agent picks a market from the descriptor, not a constant.
 *   2. ONBOARD   — deposit trading collateral into the Vault + a Gateway balance for nanopayments.
 *   3. OBSERVE   — subscribe to the per-block stream; read live mark / skew / funding / OI / my account.
 *   4. DECIDE    — a tiny skew-reversion policy (lean against the crowd) — replace with your own edge.
 *   5. ACT       — open / hold / close via the SDK; one position per market (POC).
 *   6. SETTLE    — each block, answer any open margin call as a gas-free Gateway x402 nanopayment.
 *                  Miss it and the venue decrements you smoothly — there is no liquidation cliff.
 *
 * Signer (Circle-first): set a Circle developer-controlled wallet (MPC custody, no raw key) —
 *   export CIRCLE_API_KEY=… CIRCLE_ENTITY_SECRET=… CIRCLE_WALLET_ID=…
 * or a raw EOA — export AGENT_PRIVATE_KEY=0x… (USDC is the gas token too). Then:
 *   export ENGINE_URL=http://localhost:8787  # the SideKick engine (default; omit to use it)
 *   bun run examples/standalone-agent.ts --collateral 10 --leverage 5 --blocks 30
 *
 * No raw key + want one? `--new-key` prints a fresh EOA to fund from the Circle Arc-testnet USDC
 * faucet, then re-run with AGENT_PRIVATE_KEY set to it. (For a Circle wallet, see circle-wallet-agent.ts.)
 */

import {
  deriveAgent,
  generateAgentsMnemonic,
  type MarketBlockState,
  type MarketSymbol,
  SideKick,
  type VenueMarketDescriptor,
} from "@sidekick/sdk";

// ── tiny CLI / env helpers (no deps) ──────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = i !== -1 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// `--new-key` — print a fresh, fundable EOA and exit (the "I have nothing yet" on-ramp).
if (hasFlag("new-key")) {
  const id = deriveAgent(generateAgentsMnemonic(), 0, "standalone");
  console.log("Fresh agent identity (fund this address with Arc-testnet USDC, then re-run):\n");
  console.log(`  address     : ${id.address}`);
  console.log(`  AGENT_PRIVATE_KEY=${id.privateKey}\n`);
  console.log("Faucet: Circle Arc-testnet USDC → send a few USDC to the address above.");
  process.exit(0);
}

/** Pick the market to trade from the venue descriptor: prefer a live oracle mark (Stork or Chainlink). */
function pickMarket(markets: VenueMarketDescriptor[], prefer?: string): VenueMarketDescriptor {
  if (prefer) {
    const m = markets.find((x) => x.symbol === prefer);
    if (!m) throw new Error(`market ${prefer} is not live on this venue`);
    return m;
  }
  // Prefer a market whose mark is a real on-chain oracle value (stork-live OR chainlink-live) over a
  // synthetic fallback. Matching `-live` keeps this source-agnostic as more sources are added.
  const live = markets.find((m) => m.live?.markProvenance?.endsWith("-live"));
  const chosen = live ?? markets[0];
  if (!chosen) throw new Error("the venue exposes no markets");
  return chosen;
}

/**
 * The agent's edge — a minimal skew-reversion policy you should replace. SideKick pays funding to
 * whoever leans AGAINST the crowd (the under-represented side), so we take the side opposite the
 * current skew and hold. `skew > 0` ⇒ crowd is long ⇒ we go short to receive funding, and vice-versa.
 * Returns the desired side, or null to stay flat (skew too small to bother).
 */
function desiredSide(state: MarketBlockState): "long" | "short" | null {
  const SKEW_DEADBAND = 0.05; // ignore noise around balanced
  if (state.smoothSkew > SKEW_DEADBAND) return "short"; // crowd long → we short (receive funding)
  if (state.smoothSkew < -SKEW_DEADBAND) return "long"; // crowd short → we long
  return null;
}

async function main(): Promise<void> {
  const engineUrl = process.env.ENGINE_URL ?? "http://localhost:8787";
  const collateral = arg("collateral", "10"); // USDC posted as margin per open
  const leverage = Number(arg("leverage", "5"));
  const maxBlocks = Number(arg("blocks", "30")); // stop after this many blocks (then close out)
  const preferMarket = arg("market", "") || undefined;

  // SIGNER (Circle-first): a Circle developer-controlled wallet (MPC custody, no raw key in this
  // process) if CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + CIRCLE_WALLET_ID are set; else a raw
  // AGENT_PRIVATE_KEY EOA. Both trade + answer margin calls identically — SideKick takes a signer.
  const { CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID, AGENT_PRIVATE_KEY } = process.env;
  let sk: SideKick;
  if (CIRCLE_API_KEY && CIRCLE_ENTITY_SECRET && CIRCLE_WALLET_ID) {
    const { circleSigner } = await import("@sidekick/sdk/circle");
    const { account, broadcaster } = await circleSigner({
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
      walletId: CIRCLE_WALLET_ID,
    });
    sk = new SideKick({ network: "arc-testnet", account, broadcaster, engineUrl });
    console.log(`agent ${sk.address} (Circle MPC wallet, no raw key)`);
  } else if (AGENT_PRIVATE_KEY) {
    sk = new SideKick({
      network: "arc-testnet",
      privateKey: AGENT_PRIVATE_KEY as `0x${string}`,
      engineUrl,
    });
    console.log(`agent ${sk.address} (raw key)`);
  } else {
    console.error(
      "Set a Circle wallet (CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + CIRCLE_WALLET_ID) or " +
        "AGENT_PRIVATE_KEY (a funded Arc-testnet EOA; or run with --new-key to mint one).",
    );
    process.exit(1);
  }

  // 1) DISCOVER — learn the venue from one call (no imported constants, no hardcoded addresses).
  const venue = await sk.venue();
  const market = pickMarket(venue.markets, preferMarket);
  const symbol = market.symbol as MarketSymbol;
  console.log(
    `\nvenue "${venue.name}" v${venue.version} on chain ${venue.chainId} ` +
      `(${venue.cadence.blockSeconds}s blocks, checkpoint every ${venue.cadence.checkpointEveryBlocks})`,
  );
  console.log(
    `trading ${symbol} — mark $${market.live?.mark ?? "?"} (${market.live?.markProvenance}), ` +
      `skew ${market.live?.skew?.toFixed(3)}, maintenance m=${market.params.m}, max leverage ~${1 / market.params.m}x`,
  );

  // 2) ONBOARD — post trading collateral + a Gateway balance for gas-free margin-call nanopayments.
  //    Skipped automatically if the deposits would be zero. Idempotent-ish (adds to existing).
  const vaultUSDC = (Number(collateral) * 2).toString(); // post 2× so there's headroom to answer calls
  const gatewayUSDC = "5"; // the off-chain balance margin-call payments draw against
  console.log(
    `\nonboarding: deposit ${vaultUSDC} USDC collateral + ${gatewayUSDC} USDC to Gateway…`,
  );
  try {
    const res = await sk.onboard({ depositUSDC: vaultUSDC, gatewayUSDC });
    console.log(`  vault tx   : ${res.vaultDepositTx ?? "(skipped)"}`);
    console.log(`  gateway tx : ${res.gatewayDepositTx ?? "(skipped)"}`);
  } catch (err) {
    console.error(
      `onboard failed (is the EOA funded with USDC?): ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
  const free = await sk.freeCollateral();
  console.log(`  free collateral now: ${(Number(free) / 1e6).toFixed(2)} USDC`);

  // 3–6) OBSERVE → DECIDE → ACT → SETTLE, once per block.
  console.log(`\nlive loop on ${symbol} (${maxBlocks} blocks, then close out)…\n`);
  let blocks = 0;
  let acting = false; // serialize: never fire a second action while one is in flight
  let done: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const unsubscribe = sk.on("block", (state) => {
    if (state.market !== symbol) return; // the engine may stream multiple markets
    void onBlock(state);
  });

  async function onBlock(state: MarketBlockState): Promise<void> {
    if (acting) return;
    acting = true;
    try {
      blocks += 1;

      // SETTLE — answer any open margin call first (gas-free x402 Gateway nanopayment).
      const owed = await sk.owed(symbol);
      if (owed > 0n) {
        const r = await sk.answerMarginCall(symbol);
        console.log(
          `  block ${blocks}: margin call ${(Number(owed) / 1e6).toFixed(4)} USDC → ` +
            (r.settled ? `paid ${r.amount} (x402) ✓` : `not settled (${r.reason})`),
        );
      }

      // OBSERVE — my account joined with the live mark.
      const me = await sk.getAccount(symbol);

      // DECIDE + ACT.
      if (blocks >= maxBlocks) {
        if (me.side !== "flat") {
          const tx = await sk.close(symbol);
          await sk.confirm(tx);
          console.log(
            `  block ${blocks}: reached --blocks ${maxBlocks} → closed (${me.side} → flat)`,
          );
        }
        unsubscribe();
        sk.disconnect();
        done();
        return;
      }

      const want = desiredSide(state);
      if (me.side === "flat" && want) {
        const tx = await sk.open({ market: symbol, side: want, collateral, leverage });
        await sk.confirm(tx);
        console.log(
          `  block ${blocks}: skew ${state.smoothSkew.toFixed(3)} → OPEN ${want} ` +
            `${collateral}@${leverage}x · funding ${state.fundingRate.toExponential(2)}/period · ${tx.slice(0, 12)}…`,
        );
      } else if (me.side !== "flat" && want && want !== me.side) {
        // Skew flipped to the other side — flip our position to keep receiving funding.
        const closeTx = await sk.close(symbol);
        await sk.confirm(closeTx);
        const openTx = await sk.open({ market: symbol, side: want, collateral, leverage });
        await sk.confirm(openTx);
        console.log(`  block ${blocks}: skew flipped → ${me.side} → ${want} (re-centered)`);
      } else {
        console.log(
          `  block ${blocks}: hold ${me.side} · equity ${me.equity} · skew ${state.smoothSkew.toFixed(3)} · mark $${state.mark}`,
        );
      }
    } catch (err) {
      console.error(
        `  block ${blocks}: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
      );
    } finally {
      acting = false;
    }
  }

  await finished;
  console.log("\ndone — position closed, stream disconnected.");
  process.exit(0);
}

main().catch((err) => {
  console.error("standalone-agent failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
