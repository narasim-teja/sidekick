/**
 * The per-block loop (Layer A + B), live against Arc. For each market, on each Arc block tick:
 *
 *   1. Fetch the mark via the pluggable oracle (Stork live, synthetic fallback).
 *   2. Read authoritative on-chain state (positions, free collateral, pool, carried EMA).
 *   3. Run the off-chain §4.3 reconciliation (fixed-point) — predicts what `checkpoint` will do.
 *   4. Record Layer B deltas: the funding stream + any answered margin calls (settled via Gateway).
 *   5. At the checkpoint cadence, trigger `checkpoint(marketId, mark, accounts)` on-chain — the
 *      authoritative state transition (mark → fund → check → settle → decrement, atomically).
 *   6. Emit the per-block {@link MarketBlockState} to subscribers (SDK + dashboard).
 *
 * Graceful fallback (Doc 2 §3.2): the loop does not have to checkpoint every block. It reconciles
 * (reads + predicts + streams) every tick, but only writes `checkpoint` every `checkpointEveryBlocks`
 * ticks — so if the 2s cadence is tight, the on-chain cost stays bounded and the design "degrades
 * smoothly" (per-block is the target; every-N-blocks is the safe fallback, no architectural change).
 *
 * The mark is injected into `checkpoint` (the oracle read), exactly as Phase 2 intended; Phase 6
 * routes the same mark through the CRE workflow.
 */

import type { MarketConfig, MarketSymbol } from "@sidekick/shared";
import { getEffectiveMarket } from "@sidekick/shared";
import type { Address } from "viem";
import type { AccountTracker } from "./chain/accounts.ts";
import type { Venue } from "./chain/venue.ts";
import { type Cadence, type ReconcileInput, reconcileBlock } from "./compute/reconcile.ts";
import { toFixedParams } from "./fixed/params.ts";
import { formatUsdc, formatWad, wadToFloat } from "./fixed/units.ts";
import type { ResilientOracle } from "./oracle/index.ts";
import type { PaymentLedger } from "./payments/ledger.ts";
import type { MarketBlockState, PoolState, PositionState, SettlementEvent } from "./state.ts";

/** Per-market runtime wiring the loop needs. */
export interface MarketRuntime {
  symbol: MarketSymbol;
  config: MarketConfig;
  oracle: ResilientOracle;
  tick: number;
}

/** Dependencies the loop is constructed with. */
export interface LoopDeps {
  venue: Venue;
  tracker: AccountTracker;
  ledger: PaymentLedger;
  cadence: Cadence;
  /** Checkpoint on-chain every N ticks (1 = every block; >1 = the graceful fallback). */
  checkpointEveryBlocks: number;
  /** Emit a per-block state to subscribers. */
  emit: (state: MarketBlockState) => void;
  /** Optional logger. */
  log?: (msg: string) => void;
}

/**
 * Run one market's reconciliation for one tick at the given Arc block. Reads state, computes the
 * §4.3 prediction, records Layer B deltas, checkpoints on-chain at the cadence, and emits state.
 * Returns the emitted {@link MarketBlockState}.
 */
export async function runMarketTick(
  rt: MarketRuntime,
  arcBlock: number,
  deps: LoopDeps,
): Promise<MarketBlockState> {
  const { venue, tracker, ledger, cadence } = deps;
  rt.tick += 1;
  const at = nowMs();

  const isCheckpointTick = rt.tick % deps.checkpointEveryBlocks === 0;

  // 0. Resolve this market's open accounts FIRST. An idle market (no open positions) needs none of the
  //    per-block on-chain work below — no Stork push (a payable tx), no per-account reads, no pool
  //    snapshot, no checkpoint. Skipping it is the load fix that lets the engine run all 4 markets
  //    (Stork BTC/XAU + Chainlink ETH/LINK) on a single free-tier RPC without saturating it into
  //    "HTTP request failed": only the traded market(s) pay the full read cost; the rest cost one mark
  //    read and still appear on the dashboard with a live, drifting mark.
  await tracker.sync(BigInt(arcBlock));
  const accounts = tracker.accounts(rt.symbol);
  const isActive = accounts.length > 0;

  // 1. Pull-oracle refresh (Stork markets only), on the checkpoint cadence — and ONLY for an active
  //    market (no point paying for an on-chain mark push nobody is trading against). Pushing before the
  //    mark read means the prediction + checkpoint use the fresh value. Chainlink markets are refreshed
  //    by the external CRE markfeed workflow. A push failure is non-fatal (pushStorkMark returns null).
  if (isActive && isCheckpointTick && rt.oracle.primarySource === "stork") {
    const tx = await venue.pushStorkMark(rt.config.asset);
    if (tx) {
      await venue.confirm(tx);
      // The feed is now fresh on-chain — clear any synthetic latch so the getMark below re-probes the
      // primary immediately (rather than serving synthetic until the slow periodic re-probe).
      rt.oracle.clearFallback();
      deps.log?.(`[${rt.symbol}] pushed Stork mark (${rt.config.asset}) ${tx}`);
    } else {
      deps.log?.(
        `[${rt.symbol}] Stork push skipped (no key / fetch failed) — using last/synthetic mark`,
      );
    }
  }

  // 2. Mark (always — a cheap single read; keeps every market's mark live on the dashboard).
  const mark = await rt.oracle.getMark();
  const markWad = mark.price18;

  // 3. Idle market: emit a lightweight mark-only state and return — skip all the expensive reconcile
  //    reads/txns. (When an account opens here, `isActive` flips true next tick and full reconcile
  //    resumes.)
  if (!isActive) {
    const state = idleState(rt, arcBlock, mark.price18, mark.provenance, at);
    deps.emit(state);
    return state;
  }

  // 4. Land any Gateway nanopayments settled via the x402 `/pay` route since the last tick — BEFORE
  //    reading state — so the on-chain margin (and the prediction + checkpoint below) reflect them.
  //    These are the proactive top-ups; the contract's own settle step is handled at step 6.
  await landAnsweredCalls(rt.symbol, deps);

  // 5. Read on-chain state for the market's accounts.
  const [smoothSkewPrev, inputs] = await Promise.all([
    venue.smoothSkewPrev(rt.symbol),
    readInputs(venue, rt.symbol, accounts),
  ]);
  const params = toFixedParams(rt.config.params);

  // 6. Off-chain §4.3 reconciliation (the prediction equal to the on-chain checkpoint).
  const result = reconcileBlock(inputs, markWad, params, smoothSkewPrev, cadence);

  // 7. Layer B: record the funding stream + the pool's net funding. `pr.paid` is the contract's OWN
  //    in-checkpoint settle step (margin call paid from collateral already in the Vault) — an
  //    on-chain internal move, recorded as `auto-settle`, NOT a Gateway nanopayment. Real x402
  //    nanopayments are recorded by the `/pay` route and landed at step 4.
  for (const pr of result.positions) {
    if (pr.funding !== 0n) {
      ledger.recordFunding(rt.tick, rt.symbol, pr.account, pr.funding, at);
    }
    if (pr.paid > 0n) {
      ledger.recordAutoSettle(rt.tick, rt.symbol, pr.account, pr.paid, at);
    }
  }
  ledger.recordPoolFunding(rt.symbol, result.poolFundingReceived);

  // 8. Authoritative on-chain checkpoint at the cadence (skip ticks in between — graceful fallback).
  let checkpoint: MarketBlockState["checkpoint"];
  const shouldCheckpoint = isCheckpointTick; // active market guaranteed here (idle returned early)
  if (shouldCheckpoint) {
    try {
      const txHash = await venue.checkpoint(rt.symbol, markWad, accounts);
      const ok = await venue.confirm(txHash);
      if (ok) {
        const index = Number(await venue.checkpointCount(rt.symbol));
        checkpoint = { txHash, index };
        deps.log?.(
          `[${rt.symbol}] checkpoint #${index} @ $${formatWad(markWad)} (${accounts.length} accts) ${txHash}`,
        );
      } else {
        deps.log?.(`[${rt.symbol}] checkpoint tx reverted: ${txHash}`);
      }
    } catch (err) {
      // A checkpoint failure must not kill the loop — log and continue; next cadence retries.
      deps.log?.(
        `[${rt.symbol}] checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 9. Build + emit the per-block state.
  const pool = await venue.poolSnapshot(rt.symbol, markWad);
  const state = buildState(
    rt,
    arcBlock,
    mark.price18,
    mark.provenance,
    result,
    pool,
    params.k,
    ledger,
    checkpoint,
    at,
  );
  deps.emit(state);
  return state;
}

/**
 * Land every Gateway nanopayment that the x402 `/pay` route has settled for this market since the
 * last tick, crediting each account's on-chain position margin via `answerMarginCall`. Drains the
 * ledger's answered map (so each payment lands exactly once) and confirms each tx. A landing that
 * fails (e.g. the position closed, or insufficient free collateral) is logged and the amount is
 * re-queued so a later tick retries it — a settled payment must never be silently dropped.
 */
async function landAnsweredCalls(symbol: MarketSymbol, deps: LoopDeps): Promise<void> {
  const { venue, ledger } = deps;
  const answered = ledger.takeAllAnswered(symbol);
  for (const [account, amount] of answered) {
    try {
      const txHash = await venue.answerMarginCall(symbol, account as Address, amount);
      const ok = await venue.confirm(txHash);
      if (ok) {
        deps.log?.(
          `[${symbol}] answered margin call: ${account.slice(0, 8)}… +${formatUsdc(amount)} USDC ${txHash}`,
        );
      } else {
        ledger.requeueAnswered(symbol, account, amount);
        deps.log?.(`[${symbol}] answerMarginCall reverted (requeued): ${account.slice(0, 8)}…`);
      }
    } catch (err) {
      ledger.requeueAnswered(symbol, account, amount);
      deps.log?.(
        `[${symbol}] answerMarginCall failed (requeued): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Read each account's position + free collateral into the reconcile inputs (open positions only). */
async function readInputs(
  venue: Venue,
  symbol: MarketSymbol,
  accounts: Address[],
): Promise<ReconcileInput[]> {
  const inputs = await Promise.all(
    accounts.map(async (account) => {
      const [position, freeCollateral] = await Promise.all([
        venue.positionOf(symbol, account),
        venue.freeCollateral(account),
      ]);
      return { account, position, freeCollateral } satisfies ReconcileInput;
    }),
  );
  return inputs.filter((i) => i.position.side !== "flat");
}

/** Assemble the JSON-serializable {@link MarketBlockState} from the bigint reconcile result. */
function buildState(
  rt: MarketRuntime,
  arcBlock: number,
  markWad: bigint,
  markProvenance: MarketBlockState["markProvenance"],
  result: ReturnType<typeof reconcileBlock>,
  pool: Awaited<ReturnType<Venue["poolSnapshot"]>>,
  k: bigint,
  ledger: PaymentLedger,
  checkpoint: MarketBlockState["checkpoint"],
  at: number,
): MarketBlockState {
  const positions: PositionState[] = result.positions.map((p) => ({
    account: p.account,
    side: p.side,
    notionalBefore: formatUsdc(p.notionalBefore),
    notionalAfter: formatUsdc(p.notionalAfter),
    equity: formatUsdc(p.equity),
    funding: signedUsdc(p.funding),
    call: formatUsdc(p.call),
    paid: formatUsdc(p.paid),
    outcome: p.outcome,
  }));

  const poolState: PoolState = {
    capital: formatUsdc(pool.capital),
    gapFund: formatUsdc(pool.gapFund),
    exposure: formatUsdc(pool.exposure),
    cap: formatUsdc(k * pool.capital),
    equity: formatUsdc(pool.equity),
    fundingAccrued: signedUsdc(pool.fundingAccrued),
  };

  const settlement: SettlementEvent[] = toSettlementEvents(ledger.recent(40));

  return {
    market: rt.symbol,
    tick: rt.tick,
    arcBlock,
    mark: formatWad(markWad),
    markProvenance,
    skew: wadToFloat(result.skew),
    smoothSkew: wadToFloat(result.smoothSkew),
    fundingRate: wadToFloat(result.fundingRate),
    oiLong: formatUsdc(result.oiLong),
    oiShort: formatUsdc(result.oiShort),
    positions,
    pool: poolState,
    settlement,
    checkpoint,
    at,
  };
}

/**
 * A lightweight per-block state for an IDLE market (no open positions) — a live mark with an empty
 * book and a zeroed pool. Emitted in place of the full reconcile so an untraded market still shows on
 * the dashboard with a drifting mark, at the cost of a single mark read instead of the full per-block
 * read/tx fan-out. No `ledger` work: there are no positions, so no funding/settlement for this market.
 */
function idleState(
  rt: MarketRuntime,
  arcBlock: number,
  markWad: bigint,
  markProvenance: MarketBlockState["markProvenance"],
  at: number,
): MarketBlockState {
  const ZERO = formatUsdc(0n);
  return {
    market: rt.symbol,
    tick: rt.tick,
    arcBlock,
    mark: formatWad(markWad),
    markProvenance,
    skew: 0,
    smoothSkew: 0,
    fundingRate: 0,
    oiLong: ZERO,
    oiShort: ZERO,
    positions: [],
    pool: {
      capital: ZERO,
      gapFund: ZERO,
      exposure: ZERO,
      cap: ZERO,
      equity: ZERO,
      fundingAccrued: ZERO,
    },
    settlement: [],
    checkpoint: undefined,
    at,
  };
}

/** Signed USDC decimal string (keeps the sign for the dashboard's +/− coloring). */
function signedUsdc(amount: bigint): string {
  const s = formatUsdc(amount < 0n ? -amount : amount);
  return amount < 0n ? `-${s}` : s;
}

/**
 * Map ledger {@link Authorization}s to JSON-safe {@link SettlementEvent}s (bigint 6dp → signed decimal
 * string). Shared by the WS per-block payload AND the standalone `/settlement` REST route so both
 * serialize identically — and neither hands a raw bigint to `JSON.stringify` (which throws).
 */
export function toSettlementEvents(
  auths: ReadonlyArray<import("./payments/ledger.ts").Authorization>,
): SettlementEvent[] {
  return auths.map((a) => ({
    block: a.block,
    account: a.account,
    kind: a.kind,
    amount: signedUsdc(a.amount),
    at: a.at,
  }));
}

/** Wall-clock ms — wrapped so tests can stub if needed. */
function nowMs(): number {
  return Date.now();
}

/**
 * Build a {@link MarketRuntime} from a symbol + its oracle. Uses the *effective* market config so a
 * `DEMO_MAINTENANCE_M` override flows into the reconcile (and thus the dashboard) — see
 * `getEffectiveMarket`. Pass `env` to honor the override; defaults to `process.env`.
 */
export function makeMarketRuntime(
  symbol: MarketSymbol,
  oracle: ResilientOracle,
  env: Record<string, string | undefined> = process.env,
): MarketRuntime {
  return { symbol, config: getEffectiveMarket(symbol, env), oracle, tick: 0 };
}
