/**
 * Fixed-point market params — the WAD/integer form of the shared float `MarketParams`, matching
 * the on-chain `MarketRegistry` / generated `Params.sol`.
 *
 * The shared package keeps the swept constants as floats (one source of truth, also feeding the
 * sim and `gen:params`). The live engine needs them in the venue's units: `m, α, λ, r_max` in WAD,
 * `k` an integer. {@link toFixedParams} does that conversion with the same 12-decimal rounding
 * `gen-params.ts` uses, so the engine's params equal the on-chain `Params.defaults()` exactly.
 *
 * @see packages/contracts/src/generated/Params.sol
 * @see packages/contracts/script/gen-params.ts
 */

import type { MarketParams } from "@sidekick/shared";
import type { FundingParams } from "./funding.ts";
import { floatToWad } from "./units.ts";

/** The on-chain integer form of a market's parameters. */
export interface FixedMarketParams {
  /** Maintenance fraction m (WAD). */
  m: bigint;
  /** Funding scale α (WAD). */
  alpha: bigint;
  /** EMA smoothing λ (WAD). */
  lambda: bigint;
  /** Per-block rate clamp r_max (WAD). */
  rMax: bigint;
  /** OI-cap multiplier k (integer). */
  k: bigint;
}

/** Convert the shared float `MarketParams` to the engine/chain fixed-point form. */
export function toFixedParams(p: MarketParams): FixedMarketParams {
  return {
    m: floatToWad(p.m),
    alpha: floatToWad(p.alpha),
    lambda: floatToWad(p.lambda),
    rMax: floatToWad(p.rMax),
    k: BigInt(p.k),
  };
}

/** Extract just the {@link FundingParams} (α, r_max, λ) the funding math needs. */
export function fundingParamsOf(p: FixedMarketParams): FundingParams {
  return { alpha: p.alpha, rMax: p.rMax, lambda: p.lambda };
}
