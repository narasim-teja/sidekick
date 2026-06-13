/**
 * Funding-rate math (Doc 1 §4.1), implemented exactly as specified.
 *
 *   S        = (OI_long − OI_short) / (OI_long + OI_short)            // normalized skew [−1,+1]
 *   S_smooth = λ·S + (1 − λ)·S_smooth_prev                           // EMA, λ ≈ 0.1–0.2
 *   rate     = clamp(α · S_smooth · |S_smooth|, −r_max, +r_max)      // convex (γ = 2), clamped
 *   funding_payment = N · rate · (Δt / T)
 *
 * Kept in floating point for the Phase 1 simulation; the on-chain/engine path will mirror this
 * in fixed point. Pure functions, no state — the caller threads `S_smooth_prev`.
 */

import { BLOCK_SECONDS, FUNDING_PERIOD_SECONDS, type MarketParams } from "@sidekick/shared";

/** Normalized skew S ∈ [−1, +1]. Returns 0 when there is no open interest. */
export function skew(oiLong: number, oiShort: number): number {
  const total = oiLong + oiShort;
  if (total === 0) return 0;
  return (oiLong - oiShort) / total;
}

/** One EMA step: S_smooth = λ·S + (1 − λ)·S_smooth_prev. */
export function smoothSkew(s: number, sSmoothPrev: number, lambda: number): number {
  return lambda * s + (1 - lambda) * sSmoothPrev;
}

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Convex, clamped per-period funding rate: clamp(α · S_smooth · |S_smooth|, −r_max, +r_max).
 * The `S·|S|` form is the γ = 2 convex shape (flat near balance, quadratic toward the extremes).
 */
export function fundingRate(sSmooth: number, params: Pick<MarketParams, "alpha" | "rMax">): number {
  const raw = params.alpha * sSmooth * Math.abs(sSmooth);
  return clamp(raw, -params.rMax, params.rMax);
}

/**
 * Per-block funding payment on a position of notional `N`: N · rate · (Δt / T).
 * `rate` is the per-period rate from {@link fundingRate}; Δt and T default to the Arc block
 * time and the configured funding period. Sign follows §4.1: rate > 0 → longs pay.
 */
export function fundingPayment(
  notional: number,
  rate: number,
  blockSeconds: number = BLOCK_SECONDS,
  periodSeconds: number = FUNDING_PERIOD_SECONDS,
): number {
  return notional * rate * (blockSeconds / periodSeconds);
}
