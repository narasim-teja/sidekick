/**
 * The unified account primitive (Doc 1 §3.2): one account type for everyone — trader, LP,
 * MM-agent, oracle-agent — distinguished only by what it holds. An account is
 * `collateral + position`, subject to the same per-block funding and continuous
 * reconciliation. The pool is itself an account (it holds net exposure and pays/receives
 * funding like anyone else); see {@link Pool} for the wrapper that adds pool-specific state.
 *
 * Pure in-memory state for the Phase 1 simulation — no chain, no Gateway, just the numbers
 * the §4.3 loop mutates each block. Money is plain USDC floats (Doc 2 Phase 1 is float).
 */

/** Position direction. `flat` = no open position. */
export type Side = "long" | "short" | "flat";

/**
 * One open position. `notional` (N) is the position size in USDC at the *entry* mark, i.e.
 * `qty · entryMark`. We track `qty` (the base-asset amount, signed by side) so re-marking is
 * exact: pricePnL = qty · (mark − entryMark). `margin` is the collateral posted against this
 * position (the equity is margin + unrealized pricePnL + accrued funding, recomputed live).
 */
export interface Position {
  side: Side;
  /** Base-asset quantity held (always ≥ 0; direction lives in `side`). */
  qty: number;
  /** Entry mark price (USDC per unit) at which the position was opened/last re-based. */
  entryMark: number;
  /** Collateral posted against this position, in USDC. Decremented by funding, topped up by calls. */
  margin: number;
}

/**
 * A simulated account. `id` names the agent; `freeCollateral` is un-utilized USDC the agent
 * can draw on to answer margin calls or open more size; `position` is its single open
 * position (the POC is one-position-per-account per market, isolated). `realizedPnl` and
 * `fundingPaid` are bookkeeping for the report (not part of the live solvency math).
 */
export interface Account {
  readonly id: string;
  /** Un-utilized USDC outside any position — the agent's spendable buffer for margin calls. */
  freeCollateral: number;
  position: Position;
  /** Cumulative realized PnL booked on closes/decrements (for reporting). */
  realizedPnl: number;
  /** Cumulative funding paid (negative) or received (positive), in USDC (for reporting). */
  fundingPaid: number;
}

/** A flat (no-position) position object. */
export function flatPosition(): Position {
  return { side: "flat", qty: 0, entryMark: 0, margin: 0 };
}

/** Create a fresh account with the given free collateral and no open position. */
export function makeAccount(id: string, freeCollateral: number): Account {
  return {
    id,
    freeCollateral,
    position: flatPosition(),
    realizedPnl: 0,
    fundingPaid: 0,
  };
}

/** Signed quantity: +qty for long, −qty for short, 0 for flat. */
export function signedQty(p: Position): number {
  if (p.side === "long") return p.qty;
  if (p.side === "short") return -p.qty;
  return 0;
}

/** Current notional at a given mark: |qty| · mark (USDC). 0 for a flat position. */
export function notionalAt(p: Position, mark: number): number {
  return p.qty * mark;
}

/** Notional at entry: |qty| · entryMark (the N used when the position was opened). */
export function entryNotional(p: Position): number {
  return p.qty * p.entryMark;
}

/**
 * Unrealized price PnL of a position at `mark`: signedQty · (mark − entryMark).
 * Long profits when mark rises; short profits when mark falls.
 */
export function pricePnl(p: Position, mark: number): number {
  return signedQty(p) * (mark - p.entryMark);
}

/**
 * Equity of a position at `mark` (Doc 1 §4.3 step 1): margin + unrealized price PnL.
 * Funding is applied separately (step 2) by mutating `margin`, so equity here is the
 * post-mark, pre-funding figure unless funding has already been folded into `margin`.
 */
export function equityAt(p: Position, mark: number): number {
  return p.margin + pricePnl(p, mark);
}
