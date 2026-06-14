/**
 * The dashboard's view of the engine's per-block payload.
 *
 * These types MIRROR the engine's public contract (`packages/engine/src/state.ts`, re-exported by
 * `@sidekick/sdk`). They are duplicated here on purpose: the dashboard is a browser bundle and
 * importing `@sidekick/engine` would drag in viem / hono / the Circle SDK (all server-only). The
 * payload is plain JSON — amounts are DECIMAL STRINGS (USDC), rates/skew are numbers — so a small
 * structural mirror is the clean boundary. If the engine's `state.ts` changes shape, update this file
 * to match (the two are checked against the same `/state` response at runtime).
 *
 * @see packages/engine/src/state.ts  (the canonical source of truth)
 */

/** Where the mark came from — lets the UI label a synthetic fallback honestly. */
export type MarkProvenance = "stork-live" | "chainlink-live" | "synthetic-fallback";

/**
 * A settlement-flow event kind. `funding` is the continuous per-block stream; `auto-settle` is the
 * contract topping a position up from Vault collateral inside `checkpoint`; `margin-call` is the
 * headline x402 Gateway **nanopayment** (the sub-cent off-chain authorization the thesis rests on).
 */
export type AuthorizationKind = "funding" | "auto-settle" | "margin-call";

/** A position's per-block view (USDC decimal strings). */
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

/** A single settlement-flow event (the live nanopayment stream visual). */
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
  market: string;
  /** Engine block counter (monotonic; the loop's tick, not the Arc block number). */
  tick: number;
  /** Arc block number this tick was driven by. */
  arcBlock: number;
  /** Mark this block (USD decimal string). */
  mark: string;
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

/** The engine's overall status (REST `/status`). */
export interface EngineStatus {
  running: boolean;
  chainId: number;
  operator: string;
  markets: string[];
  checkpointEveryBlocks: number;
  totalAuthorizations: number;
  ticks: Record<string, number>;
}

/** One market's entry in the venue self-description (`/venue`). */
export interface VenueMarketDescriptor {
  symbol: string;
  name: string;
  asset: string;
  marketId: string;
  params: { m: number; alpha: number; lambda: number; rMax: number; k: number };
  oracle: { source: "stork" | "chainlink"; assetId: string };
  contracts: { pool: string; lpToken: string; oracleAdapter: string };
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

/** The venue self-description (`/venue`). */
export interface VenueDescriptor {
  name: "sidekick";
  version: string;
  chainId: number;
  deploymentBlock: number;
  operator: string;
  contracts: {
    usdc: string;
    vault: string;
    marketRegistry: string;
    perpEngine: string;
    accountManager: string;
  };
  cadence: { blockSeconds: number; checkpointEveryBlocks: number; fundingPeriodSeconds: number };
  units: {
    collateral: "USDC";
    collateralDecimals: 6;
    markDecimals: 18;
    amountsInPayloads: "decimal-string";
  };
  markets: VenueMarketDescriptor[];
}

/** A WS frame the engine pushes over `/ws`. */
export type EngineFrame =
  | { type: "block"; state: MarketBlockState }
  | { type: "hello"; version: string }
  | Record<string, unknown>;

/** How the dashboard is currently sourcing data. */
export type FeedMode = "live" | "replay" | "connecting";
