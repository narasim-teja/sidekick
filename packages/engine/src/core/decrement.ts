/**
 * Decrement rule (Doc 1 §4.2) and the per-block loop order (§4.3), implemented exactly.
 *
 * Decrement, per position, per block, on the no-pay path (β = 1, full restore):
 *   if E ≥ m·N:   healthy — do nothing
 *   elif E > 0:   N' = E / m            // shrink to maintenance-adequate at mark
 *                 ΔN = N − N'           // closed against the pool at current mark
 *   else (E ≤ 0): close fully; draw |E| from the gap fund  // the only place bad debt enters
 *
 * Loop order (§4.3, anti-double-count): mark → fund → check → call → settle → decrement.
 * Always check/decrement on the POST-funding equity. Pure functions; the caller owns state.
 */

/** Outcome kinds for a single position's per-block reconciliation. */
export type ReconcileOutcome =
  | { kind: "healthy" }
  | { kind: "decrement"; newNotional: number; closedNotional: number }
  | { kind: "gap"; badDebt: number };

/** A position is healthy iff equity ≥ m · notional. */
export function isHealthy(equity: number, notional: number, m: number): boolean {
  return equity >= m * notional;
}

/** The margin-call amount needed to restore health: max(0, m·N − E). */
export function marginCall(equity: number, notional: number, m: number): number {
  return Math.max(0, m * notional - equity);
}

/**
 * Apply the §4.2 decrement on the no-pay path, given the post-funding equity.
 * Does NOT itself check health — call {@link isHealthy} first and only invoke this when the
 * position is short and the margin call went unpaid.
 */
export function decrement(equity: number, notional: number, m: number): ReconcileOutcome {
  if (isHealthy(equity, notional, m)) return { kind: "healthy" };
  if (equity > 0) {
    const newNotional = equity / m; // N' = E / m
    return { kind: "decrement", newNotional, closedNotional: notional - newNotional };
  }
  // E ≤ 0: gap event — close fully, |E| is bad debt drawn from the gap fund.
  return { kind: "gap", badDebt: -equity };
}
