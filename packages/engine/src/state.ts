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

/**
 * One market's entry in the {@link VenueDescriptor} — everything a brand-new agent needs to trade
 * this market without any prior knowledge of the venue: its economic parameters, on-chain addresses,
 * oracle source, and a live snapshot of the headline numbers (mark / skew / funding / OI).
 */
export interface VenueMarketDescriptor {
  symbol: MarketSymbol;
  name: string;
  /** Oracle asset symbol, e.g. "BTCUSD". */
  asset: string;
  /** The bytes32 market id the on-chain registry keys by (also the SDK's `marketId`). */
  marketId: string;
  /** Economic parameters (Doc 1 §4/§10): m, α, λ, r_max, k. */
  params: { m: number; alpha: number; lambda: number; rMax: number; k: number };
  /** Which oracle source backs the mark, and whether it's a live feed or the synthetic fallback. */
  oracle: { source: "stork" | "chainlink"; assetId: string };
  /** On-chain addresses for this market (isolated pool + LP token + oracle adapter). */
  contracts: { pool: string; lpToken: string; oracleAdapter: string };
  /** Live snapshot (null until the engine has produced a state for this market). */
  live: {
    mark: string;
    markProvenance: MarkProvenance;
    skew: number;
    fundingRate: number;
    oiLong: string;
    oiShort: string;
    poolCapital: string;
  } | null;
}

/**
 * The venue's self-description (the REST `GET /venue` payload) — a single, dependency-free document
 * an external agent fetches to self-configure: the chain, the shared contracts, the per-market
 * params + addresses + live headline numbers, the block cadence, and the units convention. This is
 * the "discover the venue with zero prior knowledge" entry point that makes SideKick self-describing.
 */
export interface VenueDescriptor {
  name: "sidekick";
  /** Engine version (matches the WS `hello` frame). */
  version: string;
  chainId: number;
  /** Block the venue contracts were deployed at (event-backfill origin). */
  deploymentBlock: number;
  /** The checkpoint operator (engine signer) address. */
  operator: string;
  /** Shared (non-per-market) contract addresses. */
  contracts: {
    usdc: string;
    vault: string;
    marketRegistry: string;
    perpEngine: string;
    accountManager: string;
  };
  /** Cadence: Arc block time + how often a checkpoint lands on-chain + the funding reference period. */
  cadence: { blockSeconds: number; checkpointEveryBlocks: number; fundingPeriodSeconds: number };
  /** Units convention so a consumer never guesses decimals. */
  units: {
    collateral: "USDC";
    collateralDecimals: 6;
    markDecimals: 18;
    amountsInPayloads: "decimal-string";
  };
  /** Every market the engine is currently running. */
  markets: VenueMarketDescriptor[];
}
