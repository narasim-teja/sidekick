/**
 * Funding — the bigint mirror of `packages/contracts/src/lib/Funding.sol` (§4.1).
 *
 *   S        = (OI_long − OI_short) / (OI_long + OI_short)        // skew [−1,+1] (WAD)
 *   S_smooth = λ·S + (1 − λ)·S_smooth_prev                        // EMA (WAD)
 *   rate     = clamp(α · S_smooth · |S_smooth|, −r_max, +r_max)   // convex γ=2, clamped (WAD); per PERIOD T
 *   payment  = N · rate · (Δt / T)                                // per-BLOCK cashflow (Δt/T scales the period rate), USDC 6dp
 *
 * Units: OI / notional / payment in USDC 6dp; skew / rate / α / λ / r_max in WAD. The order of
 * operations matches the Solidity exactly (multiply before the period division in `fundingPayment`,
 * two WAD-muls for the convex term) so the truncation is identical on- and off-chain.
 *
 * @see packages/contracts/src/lib/Funding.sol
 */

import { abs, clamp, wadDiv, wadMul } from "./signed-wad.ts";
import { WAD } from "./units.ts";

/** Funding parameters, WAD. Mirrors `Funding.Params`. (The rate is per funding PERIOD T; the payment is per block.) */
export interface FundingParams {
  /** Funding scale α (WAD), ~ r_max in magnitude. */
  alpha: bigint;
  /** Per-period rate clamp r_max (WAD), ≥ 0 — the rate is per funding period T, scaled to per-block by Δt/T in the payment. */
  rMax: bigint;
  /** EMA smoothing λ (WAD), ∈ (0, 1]. */
  lambda: bigint;
}

/** Normalized skew S ∈ [−1, +1] in WAD. Returns 0 when there is no open interest. */
export function skew(oiLong: bigint, oiShort: bigint): bigint {
  const total = oiLong + oiShort;
  if (total === 0n) return 0n;
  const num = oiLong - oiShort;
  return wadDiv(num, total);
}

/** One EMA step: S_smooth = λ·S + (1 − λ)·S_smooth_prev. All WAD. */
export function smoothSkew(s: bigint, sSmoothPrev: bigint, lambda: bigint): bigint {
  const oneMinusLambda = WAD - lambda;
  return wadMul(lambda, s) + wadMul(oneMinusLambda, sSmoothPrev);
}

/** Convex, clamped per-period funding rate: clamp(α · S_smooth · |S_smooth|, −r_max, +r_max). WAD. */
export function fundingRate(sSmooth: bigint, p: FundingParams): bigint {
  const convex = wadMul(sSmooth, abs(sSmooth));
  const raw = wadMul(p.alpha, convex);
  return clamp(raw, -p.rMax, p.rMax);
}

/**
 * Per-block funding payment MAGNITUDE on a position of notional `N`: N · rate · (Δt / T), USDC 6dp.
 * Always ≥ 0 here (sign is the caller's: rate > 0 → longs pay). Multiply before the period
 * division, exactly as the Solidity does, to keep the intermediate from losing precision.
 */
export function fundingPayment(
  notional: bigint,
  rate: bigint,
  blockSeconds: bigint,
  periodSeconds: bigint,
): bigint {
  const nRate = wadMul(notional, rate); // USDC 6dp (rate de-scaled)
  return (nRate * blockSeconds) / periodSeconds;
}
