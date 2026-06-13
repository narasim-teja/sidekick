/**
 * Conservation invariants — the sim must neither create nor destroy USDC. Funding is a transfer
 * (traders ↔ pool) and a decrement is a forced partial close against the pool at mark; the only
 * sink is the gap-fund draw on the E ≤ 0 branch, accounted as bad debt. So at every block:
 *
 *   total system USDC = Σ(account free collateral + position equity@mark)
 *                     + pool capital + pool unrealized exposure PnL
 *                     + gap fund + bad debt absorbed
 *
 * stays constant (within float tolerance). Used by tests and as an optional runtime assertion.
 */

import { equityAt, pricePnl } from "./account.ts";
import type { Market } from "./market.ts";

/**
 * Total USDC in the system at `mark`. The pool is the universal counterparty, so its unrealized
 * PnL is — by construction — exactly `−Σ(open-trader unrealized price PnL)`. We therefore compute
 * the pool's unrealized contribution from the trader book directly (not from a blended pool
 * basis), which makes the trader and pool unrealized terms cancel exactly and conservation hold
 * by construction. What remains is realized USDC: free collateral + posted margin + realized PnL
 * already booked into pool capital + the gap fund.
 *
 * Note `badDebtAbsorbed` is a reporting counter, NOT a money bucket — a gap-fund draw already
 * moves the money out of `gapFund` (into the pool's realized gain on the insolvent slice), so it
 * must not be double-counted here.
 */
export function totalSystemUsdc(market: Market, mark: number): number {
  let total = 0;
  let traderUnrealized = 0;
  for (const acct of market.accounts.values()) {
    total += acct.freeCollateral + equityAt(acct.position, mark);
    traderUnrealized += pricePnl(acct.position, mark);
  }
  // Pool unrealized mirrors the traders' exactly → subtract Σ trader unrealized to cancel it.
  total += market.pool.capital - traderUnrealized;
  total += market.pool.gapFund;
  return total;
}
