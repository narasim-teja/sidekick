/**
 * The per-block state payload — the engine's public contract with the SDK (Phase 5) and the
 * dashboard (Phase 7). Emitted over WebSocket each block (and readable via REST). It is the live,
 * source-agnostic view of one market's loop: mark, skew, funding, positions, pool health, and the
 * settlement-flow stream (Doc 1 §7).
 *
 * Amounts are serialized as DECIMAL STRINGS (USDC) and numbers (rates/skew), never raw bigints, so
 * the payload is plain JSON the SDK/dashboard consume without bigint handling. The engine computes
 * in bigint internally and formats only at this boundary.
 */

import type { MarketSymbol } from "@sidekick/shared";
import type { MarkProvenance } from "./oracle/index.ts";
import type { AuthorizationKind } from "./payments/ledger.ts";

/** One position's per-block view (USDC decimal strings). */
export interface PositionState {
  account: string;
  side: "long" | "short";
  /** Notional before this block's reconciliation (USDC). */
  notionalBefore: string;
  /** Notional after (shrinks on a decrement; 0 after a close/gap). */
  notionalAfter: string;
  /** Equity after mark + funding (USDC, may be negative). */
  equity: string;
  /** Funding cashflow this block (+received / −paid, USDC). */
  funding: string;
  /** Margin call requested this block (USDC; "0" if healthy). */
  call: string;
  /** Amount answered toward the call (USDC). */
  paid: string;
  outcome: "healthy" | "topped-up" | "decrement" | "gap";
}

/**
 * A single settlement-flow event (the live nanopayment stream visual). `kind` distinguishes the
 * continuous funding stream, the contract's in-checkpoint `auto-settle` (collateral already in the
 * Vault), and a real `margin-call` Gateway nanopayment — see {@link AuthorizationKind}.
 */
export interface SettlementEvent {
  block: number;
  account: string;
  kind: AuthorizationKind;
  /** Signed USDC decimal string (+ account receives, − account pays). */
  amount: string;
  at: number;
}

/** Pool health for the market (the stable headline + exposure vs cap). */
export interface PoolState {
  /** LP-backing capital — the stable headline number (USDC). */
  capital: string;
  /** Gap-fund reserve (USDC). */
  gapFund: string;
  /** Net notional exposure |netQty|·mark (USDC). */
  exposure: string;
  /** The live Layer-2 cap k·capital this exposure is checked against (USDC). */
  cap: string;
  /** Pool equity at mark = capital + unrealized exposure PnL (USDC). */
  equity: string;
  /** Cumulative funding the pool has received (USDC). */
  fundingAccrued: string;
}

/** Everything observable about one market at the end of a block — the WS/REST payload. */
export interface MarketBlockState {
  market: MarketSymbol;
  /** Engine block counter (monotonic; the loop's tick, not the Arc block number). */
  tick: number;
  /** Arc block number this tick was driven by. */
  arcBlock: number;
  /** Mark this block (USD decimal string). */
  mark: string;
  /** Where the mark came from (so the UI can label a synthetic fallback honestly). */
  markProvenance: MarkProvenance;
  /** Raw instantaneous skew S ∈ [−1,+1]. */
  skew: number;
  /** EMA-smoothed skew carried across blocks. */
  smoothSkew: number;
  /** Per-period funding rate. */
  fundingRate: number;
  /** Long / short open interest (USDC). */
  oiLong: string;
  oiShort: string;
  positions: PositionState[];
  pool: PoolState;
  /** Recent settlement-flow events (the nanopayment stream). */
  settlement: SettlementEvent[];
  /** Whether this block triggered an on-chain checkpoint, and its tx hash if so. */
  checkpoint?: { txHash: string; index: number };
  /** Engine timestamp (ms). */
  at: number;
}

/** The engine's overall status (for the REST /status endpoint + dashboard header). */
export interface EngineStatus {
  running: boolean;
  chainId: number;
  operator: string;
  /** Markets the engine is looping over. */
  markets: MarketSymbol[];
  /** Reconcile cadence: checkpoint every N Arc blocks (graceful fallback if behind 2s). */
  checkpointEveryBlocks: number;
  /** Total Layer B authorizations recorded so far. */
  totalAuthorizations: number;
  /** Latest tick per market. */
  ticks: Record<string, number>;
}
