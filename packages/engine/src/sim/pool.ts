/**
 * The pool (Doc 1 §3.1, §3.3): a single isolated USDC pool per market that is the default
 * counterparty to every position and the absorber of decremented size. Because it is the
 * counterparty, the pool holds the *negative* of the traders' net signed quantity — whatever
 * the traders do not balance among themselves, the pool holds (Doc 3 §4: "skew is the pool's
 * risk"). It pays/receives funding like any account.
 *
 * Two solvency bounds live here:
 *   Layer 1 (convex skew funding) — lives in the funding math (core/funding.ts), applied by
 *     the market loop; the pool just receives the funding it is owed.
 *   Layer 2 (OI cap vs pool capital) — `admits()` below: net pool-absorbed exposure is capped
 *     to `k · poolCapital`, checked before admitting any new position delta (Doc 1 §3.3 L2).
 *
 * The gap fund (Layer 4, POC token form) is held here too and drawn only on the `E ≤ 0`
 * decrement branch (Doc 1 §4.2) — the single place bad debt enters the system.
 */

/**
 * Pool state. `capital` is the LP-backing USDC (the headline "pool capital / LP claim value"
 * from Doc 1 §7). `gapFund` is the small Layer-4 reserve. `netQty` is the pool's signed
 * base-asset exposure: it is, by construction, −Σ(trader signedQty), so the book always nets
 * to zero. `entryNotionalSum` tracks the cost basis the pool absorbed (for PnL reporting).
 */
export interface Pool {
  /** LP-backing capital in USDC — the stable headline number (Doc 1 §7). */
  capital: number;
  /** Layer-4 gap fund reserve in USDC; drawn only on the E ≤ 0 branch. */
  gapFund: number;
  /** Pool's net signed base-asset quantity (= −Σ trader signedQty). */
  netQty: number;
  /** Weighted entry mark of the pool's net exposure (for marking pool PnL). */
  entryMark: number;
  /** Cumulative funding the pool received (+) or paid (−), USDC (reporting). */
  fundingPaid: number;
  /** Cumulative bad debt absorbed via the gap fund, USDC (reporting). */
  badDebtAbsorbed: number;
}

/** Create a pool seeded with `capital` USDC and a `gapFund` reserve, flat exposure. */
export function makePool(capital: number, gapFund: number): Pool {
  return {
    capital,
    gapFund,
    netQty: 0,
    entryMark: 0,
    fundingPaid: 0,
    badDebtAbsorbed: 0,
  };
}

/** Pool's net notional exposure (USDC) at `mark`: |netQty| · mark. */
export function poolExposure(pool: Pool, mark: number): number {
  return Math.abs(pool.netQty) * mark;
}

/**
 * The §3.3 Layer-2 hard ceiling: pool-absorbed exposure must stay ≤ `k · capital`. Returns
 * true iff admitting an additional signed-quantity delta `deltaQty` (the side the pool would
 * take, i.e. the *opposite* of the trader's) keeps |pool exposure| within the cap at `mark`.
 *
 * The cap floats with live capital (tightens as capital shrinks), and because exposure is a
 * function of the post-trade `netQty`, a trade that *reduces* pool exposure is always admitted
 * even when currently at the cap (the rebate / balancing side is never refused).
 */
export function admits(pool: Pool, poolDeltaQty: number, mark: number, k: number): boolean {
  const newNetQty = pool.netQty + poolDeltaQty;
  const newExposure = Math.abs(newNetQty) * mark;
  const cap = k * pool.capital;
  // Always admit if the trade does not increase exposure (reducing skew is never blocked).
  if (newExposure <= Math.abs(pool.netQty) * mark) return true;
  return newExposure <= cap;
}

/**
 * Apply a trader opening/changing a position: the pool takes the opposite side. `traderDeltaQty`
 * is the signed change in the *trader's* exposure; the pool absorbs `−traderDeltaQty`. Updates
 * the pool's volume-weighted entry mark so its mark-to-market PnL is exact.
 *
 * Caller MUST have checked {@link admits} first for the opening direction.
 */
export function absorb(pool: Pool, traderDeltaQty: number, mark: number): void {
  const poolDelta = -traderDeltaQty;
  const prevQty = pool.netQty;
  const newQty = prevQty + poolDelta;
  const growingSameDir =
    (prevQty === 0 || Math.sign(prevQty) === Math.sign(newQty)) &&
    Math.abs(newQty) >= Math.abs(prevQty);

  if (growingSameDir) {
    // Growing same-direction exposure: weight the new lot in at `mark`.
    const addedQty = newQty - prevQty;
    const prevNotional = prevQty * pool.entryMark;
    const addedNotional = addedQty * mark;
    pool.entryMark = newQty === 0 ? 0 : (prevNotional + addedNotional) / newQty;
  } else if (Math.sign(prevQty) !== Math.sign(newQty) && newQty !== 0) {
    // Crossed through zero (flip): the remaining exposure is freshly opened at `mark`.
    pool.entryMark = mark;
  }
  // Shrinking same-direction exposure keeps the basis; realized PnL is booked by the caller
  // (market.ts) as the mirror of the trader's realized PnL, so the pool's reported unrealized
  // PnL stays exactly −Σ(open-trader unrealized PnL) and capital is conserved.
  pool.netQty = newQty;
  if (newQty === 0) pool.entryMark = 0;
}

/** Pool's unrealized price PnL at `mark`: netQty · (mark − entryMark). */
export function poolPricePnl(pool: Pool, mark: number): number {
  return pool.netQty * (mark - pool.entryMark);
}

/** Total pool equity at `mark`: capital + unrealized exposure PnL. */
export function poolEquity(pool: Pool, mark: number): number {
  return pool.capital + poolPricePnl(pool, mark);
}

/**
 * Draw `amount` of bad debt from the gap fund (Layer 4). Returns the amount actually covered;
 * any shortfall (gap fund exhausted) is the residual that, in the full design, would hit
 * socialized deleveraging — surfaced to the caller so the sim can flag it.
 */
export function drawGapFund(pool: Pool, amount: number): { covered: number; shortfall: number } {
  const covered = Math.min(amount, pool.gapFund);
  pool.gapFund -= covered;
  pool.badDebtAbsorbed += amount;
  return { covered, shortfall: amount - covered };
}
