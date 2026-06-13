/**
 * The five SideKick markets and their economic parameters.
 *
 * Each market is an isolated pool parameterized by `{m, α, λ, r_max, k}` (Doc 1 §10). The
 * values here are **pre-sweep defaults** seeded from Doc 1 §4 — they are deliberately
 * placeholders to be overwritten by the Phase 1 simulation sweep (Doc 2 Phase 1), which
 * writes the chosen constants back to this file. `γ` (the funding convexity) is fixed at 2
 * and is not swept.
 *
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §4 (formulas), §10 (markets)
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 1 (constants sweep)
 */

import type { Hex } from "viem";
import type { OracleConfig } from "./oracle.ts";
import { storkAssetId } from "./oracle.ts";

export type MarketSymbol = "BTC-PERP" | "ETH-PERP" | "SOL-PERP" | "HYPE-PERP" | "LINK-PERP";

/**
 * Funding + risk parameters for one market. Mirrors the §4 formulas exactly:
 *   S_smooth = λ·S + (1−λ)·S_smooth_prev
 *   rate     = clamp(α · S_smooth · |S_smooth|, −r_max, +r_max)   // γ = 2 (convex)
 * and the §3.3 Layer-2 cap: pool net exposure ≤ k · poolCapital.
 */
export interface MarketParams {
  /** Maintenance fraction `m`: position healthy iff equity ≥ m·N. (e.g. 0.01 = 1%). */
  readonly m: number;
  /** Funding scale `α`: overall gain on the convex skew→rate curve. */
  readonly alpha: number;
  /** EMA smoothing `λ` ∈ (0,1], the manipulation-resistance dial (≈0.1–0.2). */
  readonly lambda: number;
  /** Per-block funding-rate clamp `r_max` (circuit breaker on the rate itself). */
  readonly rMax: number;
  /** OI-cap multiplier `k`: pool-absorbed skew capped to k·poolCapital. */
  readonly k: number;
}

/** Fixed funding convexity exponent (`S·|S|` shape). Not swept. */
export const FUNDING_GAMMA = 2 as const;

/**
 * Funding period `T` and block cadence `Δt` (Arc ~2s blocks). The per-block payment is
 * `N · rate · (Δt / T)` (Doc 1 §4.1). Both in seconds.
 */
export const FUNDING_PERIOD_SECONDS = 8 * 60 * 60; // 8h reference period (rate is per-period)
export const BLOCK_SECONDS = 2; // Arc ~2s production block time

/** Decrement aggressiveness β (Doc 1 §4.2). β=1 = fully restore maintenance each block. */
export const DECREMENT_BETA = 1 as const;

export interface MarketConfig {
  readonly symbol: MarketSymbol;
  readonly name: string;
  /** Asset symbol used for oracle lookups, e.g. "BTCUSD". */
  readonly asset: string;
  readonly params: MarketParams;
  /** Which oracle source + identifier backs this market's mark (pluggable). */
  readonly oracle: OracleConfig;
  /** Short note on why the market is in the set. */
  readonly note: string;
}

/**
 * Pre-sweep default parameters, shared across markets until Phase 1 differentiates them.
 * Conservative starting point: 1% maintenance, mild funding gain, λ at the low end for
 * manipulation resistance, a 0.1%/period rate cap, and a 5× pool-capital OI cap.
 */
const DEFAULT_PARAMS: MarketParams = {
  m: 0.01,
  alpha: 0.5,
  lambda: 0.15,
  rMax: 0.001,
  k: 5,
};

/** Build a Stork-backed oracle config for an asset symbol. */
// Spike B (2026-06-13) verified `storkAssetId(symbol) === keccak256(utf8(symbol))` matches the
// Stork registry exactly for all five assets, so the helper is the source of truth — no need to
// pin literals. Note: on Arc TESTNET only BTCUSD is currently pushed; ETH/SOL/LINK/HYPE have
// valid ids but no value yet, so reading them requires pushing a fresh signed update first.
function storkOracle(asset: string): OracleConfig {
  return { source: "stork", asset, assetId: storkAssetId(asset) };
}

/** Build a Chainlink-backed oracle config (feedId confirmed Day-1 in Spike B). */
function chainlinkOracle(asset: string, feedId: Hex): OracleConfig {
  return { source: "chainlink", asset, feedId };
}

/**
 * The five markets. All default to Stork for the mark (the pull-based, low-latency source
 * confirmed live on Arc); LINK-PERP is the natural candidate to also exercise the Chainlink
 * path for the Connect-the-World bounty once feed ids are confirmed in Spike B.
 */
export const MARKETS: Record<MarketSymbol, MarketConfig> = {
  "BTC-PERP": {
    symbol: "BTC-PERP",
    name: "Bitcoin",
    asset: "BTCUSD",
    params: DEFAULT_PARAMS,
    oracle: storkOracle("BTCUSD"),
    note: "flagship, deepest reference",
  },
  "ETH-PERP": {
    symbol: "ETH-PERP",
    name: "Ethereum",
    asset: "ETHUSD",
    params: DEFAULT_PARAMS,
    oracle: storkOracle("ETHUSD"),
    note: "flagship",
  },
  "SOL-PERP": {
    symbol: "SOL-PERP",
    name: "Solana",
    asset: "SOLUSD",
    params: DEFAULT_PARAMS,
    oracle: storkOracle("SOLUSD"),
    note: "major",
  },
  "HYPE-PERP": {
    symbol: "HYPE-PERP",
    name: "Hyperliquid",
    asset: "HYPEUSD",
    params: DEFAULT_PARAMS,
    oracle: storkOracle("HYPEUSD"),
    note: "on-thesis (perp-native asset)",
  },
  "LINK-PERP": {
    symbol: "LINK-PERP",
    name: "Chainlink",
    asset: "LINKUSD",
    params: DEFAULT_PARAMS,
    // Defaults to Stork; swap to chainlinkOracle("LINKUSD", "0x…") once the Arc feed id is
    // confirmed (Spike B) to drive the Connect-the-World on-chain write on this market.
    oracle: storkOracle("LINKUSD"),
    note: "on-thesis (oracle token; pairs with the Chainlink/CRE story)",
  },
};

/** All market symbols, in canonical order. */
export const MARKET_SYMBOLS = Object.keys(MARKETS) as MarketSymbol[];

/** Lookup a market config by symbol, throwing on an unknown symbol. */
export function getMarket(symbol: MarketSymbol): MarketConfig {
  const market = MARKETS[symbol];
  if (!market) throw new Error(`Unknown market: ${symbol}`);
  return market;
}

// Exported builders so Phase 1 / Phase 2 can re-key a market onto Chainlink without
// reaching into the literal above.
export { chainlinkOracle, storkOracle };
