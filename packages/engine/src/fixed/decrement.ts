/**
 * Decrement — the bigint mirror of `packages/contracts/src/lib/Decrement.sol` (§4.2 / §4.3).
 *
 *   if E ≥ m·N:   healthy — do nothing
 *   elif E > 0:   N' = E / m            // shrink to maintenance-adequate at mark
 *                 ΔN = N − N'           // closed against the pool at current mark
 *   else (E ≤ 0): close fully; |E| is bad debt drawn from the gap fund
 *
 * Units: equity E and notional N in USDC 6dp; maintenance fraction `m` in WAD. `m·N` is
 * `wadMul(m, N)` (→ 6dp); `N' = E/m` is `wadDiv(E, m)` (→ 6dp). Pure arithmetic over the
 * POST-funding equity — the caller owns the §4.3 ordering and only decrements an unpaid position.
 *
 * @see packages/contracts/src/lib/Decrement.sol
 */

import { wadDiv, wadMul } from "./signed-wad.ts";

/** Outcome kind for one position's reconciliation. Mirrors `Decrement.Kind`. */
export type DecrementKind = "healthy" | "decrement" | "gap";

/** The result of {@link applyDecrement}. `newNotional`/`closedNotional` on decrement; `badDebt` on gap. */
export interface DecrementOutcome {
  kind: DecrementKind;
  /** New notional N' (USDC 6dp) — equals N on healthy, 0 on gap. */
  newNotional: bigint;
  /** Slice force-closed against the pool ΔN (USDC 6dp) — 0 on healthy. */
  closedNotional: bigint;
  /** |E| bad debt drawn from the gap fund (USDC 6dp) — only set on gap. */
  badDebt: bigint;
}

/** A position is healthy iff equity ≥ m · notional. `m` WAD, equity/notional 6dp. */
export function isHealthy(equity: bigint, notional: bigint, m: bigint): boolean {
  const required = wadMul(m, notional);
  return equity >= required;
}

/** The margin-call amount needed to restore health: max(0, m·N − E), in USDC 6dp. */
export function marginCall(equity: bigint, notional: bigint, m: bigint): bigint {
  const required = wadMul(m, notional);
  const shortfall = required - equity;
  return shortfall > 0n ? shortfall : 0n;
}

/**
 * Apply the §4.2 decrement given the POST-funding equity. Does not re-check the margin call —
 * the caller invokes this only when the position is short and the call went unpaid.
 */
export function applyDecrement(equity: bigint, notional: bigint, m: bigint): DecrementOutcome {
  if (isHealthy(equity, notional, m)) {
    return { kind: "healthy", newNotional: notional, closedNotional: 0n, badDebt: 0n };
  }
  if (equity > 0n) {
    let newNotional = wadDiv(equity, m); // N' = E / m (→ 6dp)
    // Guard the dust edge where rounding nudges N' just above N: never grow on a decrement.
    if (newNotional > notional) newNotional = notional;
    return {
      kind: "decrement",
      newNotional,
      closedNotional: notional - newNotional,
      badDebt: 0n,
    };
  }
  // E ≤ 0: gap — close fully, |E| is the bad debt drawn from the gap fund.
  return { kind: "gap", newNotional: 0n, closedNotional: notional, badDebt: -equity };
}
