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
import { getMarket } from "@sidekick/shared";
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

  // 1. Mark.
  const mark = await rt.oracle.getMark();
  const markWad = mark.price18;

  // 2. Read on-chain state for the market's accounts.
  await tracker.sync(BigInt(arcBlock));
  const accounts = tracker.accounts(rt.symbol);
  const [smoothSkewPrev, inputs] = await Promise.all([
    venue.smoothSkewPrev(rt.symbol),
    readInputs(venue, rt.symbol, accounts),
  ]);
  const params = toFixedParams(rt.config.params);

  // 3. Off-chain §4.3 reconciliation (the prediction equal to the on-chain checkpoint).
  const result = reconcileBlock(inputs, markWad, params, smoothSkewPrev, cadence);

  // 4. Layer B: record the funding stream + the pool's net funding.
  ledger.beginBlock();
  for (const pr of result.positions) {
    if (pr.funding !== 0n) {
      ledger.recordFunding(rt.tick, rt.symbol, pr.account, pr.funding, at);
    }
    // A margin-call shortfall the account paid this block is an answered call (settled top-up).
    if (pr.paid > 0n) {
      ledger.recordAnsweredCall(rt.tick, rt.symbol, pr.account, pr.paid, at);
    }
  }
  ledger.recordPoolFunding(rt.symbol, result.poolFundingReceived);

  // 5. Authoritative on-chain checkpoint at the cadence (skip ticks in between — graceful fallback).
  let checkpoint: MarketBlockState["checkpoint"];
  const shouldCheckpoint = accounts.length > 0 && rt.tick % deps.checkpointEveryBlocks === 0;
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

  // 6. Build + emit the per-block state.
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

  const settlement: SettlementEvent[] = ledger.recent(40).map((a) => ({
    block: a.block,
    account: a.account,
    kind: a.kind,
    amount: signedUsdc(a.amount),
    at: a.at,
  }));

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

/** Signed USDC decimal string (keeps the sign for the dashboard's +/− coloring). */
function signedUsdc(amount: bigint): string {
  const s = formatUsdc(amount < 0n ? -amount : amount);
  return amount < 0n ? `-${s}` : s;
}

/** Wall-clock ms — wrapped so tests can stub if needed. */
function nowMs(): number {
  return Date.now();
}

/** Build a {@link MarketRuntime} from a symbol + its oracle. */
export function makeMarketRuntime(symbol: MarketSymbol, oracle: ResilientOracle): MarketRuntime {
  return { symbol, config: getMarket(symbol), oracle, tick: 0 };
}
