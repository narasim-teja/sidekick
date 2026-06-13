/**
 * The per-block market engine (Doc 1 §4.3) — the deterministic Layer-A compute loop, in
 * memory, for one isolated market. It owns the accounts and the pool, runs the exact
 * mark → fund → check → call → settle → decrement sequence every block, and recomputes funding
 * from live skew (§4.1) using the pure core math. No chain, no Gateway.
 *
 * Conservation invariant (asserted in tests): USDC is neither created nor destroyed by funding
 * or decrement. Funding is a transfer (traders ↔ pool), and a decrement is a forced partial
 * close against the pool at mark; the only sink is the gap-fund draw on the E ≤ 0 branch, which
 * is explicitly accounted as bad debt. Total system USDC = Σ account equity + pool capital +
 * gap fund + bad debt absorbed stays constant block over block.
 */

import type { MarketParams } from "@sidekick/shared";
import { fundingPayment, fundingRate, marginCall, skew, smoothSkew } from "../core/index.ts";
import {
  type Account,
  entryNotional,
  equityAt,
  flatPosition,
  notionalAt,
  pricePnl,
  type Side,
  signedQty,
} from "./account.ts";
import { absorb, admits, drawGapFund, type Pool, poolEquity } from "./pool.ts";

/** An intent an agent emits at the start of a block, before the reconciliation loop runs. */
export type Action =
  | { kind: "open"; side: Exclude<Side, "flat">; notional: number; margin: number }
  | { kind: "close" }
  | { kind: "none" };

/**
 * How an agent answers a margin call this block. Returns the USDC it chooses to pay toward the
 * shortfall (clamped to its free collateral by the engine). A "dark" agent returns 0.
 */
export type MarginCallResponder = (ctx: {
  account: Account;
  shortfall: number;
  mark: number;
}) => number;

/** Per-position record of what happened this block, for metrics + the dashboard later. */
export interface PositionEvent {
  accountId: string;
  /** Equity after mark + funding, before any call/decrement. */
  equity: number;
  /** Funding cashflow this block (+received / −paid). */
  funding: number;
  /** Margin-call shortfall requested (0 if healthy). */
  call: number;
  /** Amount the agent paid toward the call. */
  paid: number;
  outcome: "healthy" | "topped-up" | "decrement" | "closed" | "gap";
  /** Notional before / after (for decrement visualization). */
  notionalBefore: number;
  notionalAfter: number;
}

/** Everything observable about the market at the end of one block — the metrics/feed payload. */
export interface BlockState {
  block: number;
  mark: number;
  /** Raw instantaneous skew S ∈ [−1,+1]. */
  skew: number;
  /** EMA-smoothed skew S_smooth carried across blocks. */
  smoothSkew: number;
  /** Per-period funding rate from §4.1. */
  fundingRate: number;
  oiLong: number;
  oiShort: number;
  poolCapital: number;
  poolEquity: number;
  /** Pool net notional exposure |netQty|·mark. */
  poolExposure: number;
  /** The live Layer-2 cap k·capital this exposure is checked against. */
  poolCap: number;
  gapFund: number;
  /** Sum of all account equities (traders only, not the pool). */
  traderEquity: number;
  events: PositionEvent[];
  /** Trades refused this block by Layer-2 admission control (skew at/over cap). */
  refusedOpens: number;
}

/** The mutable market the loop operates on. */
export interface Market {
  readonly params: MarketParams;
  readonly accounts: Map<string, Account>;
  readonly pool: Pool;
  /** Carried EMA state for the funding rate (§4.1). */
  smoothSkewPrev: number;
  block: number;
}

/** Construct a market from params, a seeded pool, and an initial set of accounts. */
export function makeMarket(params: MarketParams, pool: Pool, accounts: Account[]): Market {
  return {
    params,
    pool,
    accounts: new Map(accounts.map((a) => [a.id, a])),
    smoothSkewPrev: 0,
    block: 0,
  };
}

/** Total open interest, split long/short, valued at `mark` (USDC). */
function openInterest(market: Market, mark: number): { long: number; short: number } {
  let long = 0;
  let short = 0;
  for (const acct of market.accounts.values()) {
    const p = acct.position;
    if (p.side === "long") long += notionalAt(p, mark);
    else if (p.side === "short") short += notionalAt(p, mark);
  }
  return { long, short };
}

/**
 * Apply an agent's open/close intent at the start of a block, before reconciliation. Opens are
 * subject to Layer-2 admission control (the pool must be able to absorb the opposite side); a
 * refused open is a no-op and counted. Returns true if an open was refused by the cap.
 *
 * Opening: the trader posts `margin` from free collateral and takes `notional` of exposure at
 * `mark`; the pool absorbs the opposite quantity. Closing: realize PnL against the pool at mark,
 * return remaining equity to free collateral, and unwind the pool's offsetting exposure.
 */
function applyAction(market: Market, acct: Account, action: Action, mark: number): boolean {
  const { pool } = market;
  if (action.kind === "none") return false;

  if (action.kind === "close") {
    closePosition(market, acct, mark);
    return false;
  }

  // open — only when currently flat (the POC is one position per account per market).
  if (acct.position.side !== "flat") return false;
  const qty = action.notional / mark;
  const traderDeltaQty = action.side === "long" ? qty : -qty;
  // Layer 2: the pool absorbs −traderDeltaQty; refuse if that breaches k·capital.
  if (!admits(pool, -traderDeltaQty, mark, market.params.k)) return true;
  if (acct.freeCollateral < action.margin) return true; // cannot fund the margin

  acct.freeCollateral -= action.margin;
  acct.position = { side: action.side, qty, entryMark: mark, margin: action.margin };
  absorb(pool, traderDeltaQty, mark);
  return false;
}

/** Close a position: realize price PnL against the pool at `mark`, return equity to the agent. */
function closePosition(market: Market, acct: Account, mark: number): void {
  const p = acct.position;
  if (p.side === "flat") return;
  const equity = equityAt(p, mark);
  const realized = equity - p.margin; // trader's realized price PnL
  // The pool is the counterparty: the trader's realized PnL is the pool's mirror loss/gain.
  // Book it into pool capital so USDC is conserved, then hand the trader its equity back.
  market.pool.capital -= realized;
  acct.freeCollateral += equity;
  acct.realizedPnl += realized;
  absorb(market.pool, -signedQty(p), mark); // unwind: pool takes the opposite of −trader qty
  acct.position = flatPosition();
}

/**
 * Run exactly one block (Doc 1 §4.3). `mark` is the new mark this block; `actions` are agent
 * intents applied first; `respond` answers margin calls. Returns the observable {@link BlockState}.
 *
 * Order is load-bearing (anti-double-count, §4.3):
 *   0. apply opens/closes (admission-controlled)
 *   1. mark      — equity at new price
 *   2. fund      — equity ±= funding_payment (transfer trader ↔ pool, zero-sum)
 *   3. check     — healthy iff E ≥ m·N (post-funding)
 *   4. call      — else request margin call (m·N − E)
 *   5. settle    — if paid: top up margin
 *   6. decrement — else: N' = E/m (E>0) or close + gap fund (E ≤ 0)
 */
export function runBlock(
  market: Market,
  mark: number,
  actions: Map<string, Action>,
  respond: MarginCallResponder,
): BlockState {
  market.block += 1;
  const { params, pool } = market;

  // 0. Apply agent intents (opens/closes) under Layer-2 admission control.
  let refusedOpens = 0;
  for (const acct of market.accounts.values()) {
    const action = actions.get(acct.id) ?? { kind: "none" };
    if (applyAction(market, acct, action, mark)) refusedOpens += 1;
  }

  // Recompute skew + funding from the post-action book (§4.1).
  const { long: oiLong, short: oiShort } = openInterest(market, mark);
  const s = skew(oiLong, oiShort);
  const sSmooth = smoothSkew(s, market.smoothSkewPrev, params.lambda);
  market.smoothSkewPrev = sSmooth;
  const rate = fundingRate(sSmooth, params);

  const events: PositionEvent[] = [];
  let poolFundingReceived = 0;

  for (const acct of market.accounts.values()) {
    const p = acct.position;
    if (p.side === "flat") continue;

    const notionalBefore = entryNotional(p);

    // 1. mark — equity at the new price (margin + unrealized price PnL).
    let equity = equityAt(p, mark);

    // 2. fund — funding_payment = N · rate · (Δt/T); sign: rate>0 → longs pay, shorts receive.
    //    funding cashflow to the position is −sign(side) · |payment|. The pool holds the
    //    opposite net, so it receives −Σ(trader funding): exact conservation.
    const magnitude = fundingPayment(notionalAt(p, mark), rate);
    const sideSign = p.side === "long" ? 1 : -1;
    const funding = -sideSign * magnitude; // + received, − paid
    p.margin += funding;
    equity += funding;
    acct.fundingPaid += funding;
    poolFundingReceived -= funding; // pool gets the mirror of every trader's funding

    // 3. check — healthy iff E ≥ m·N (post-funding equity vs current notional).
    const reqNotional = notionalAt(p, mark);
    const call = marginCall(equity, reqNotional, params.m);
    if (call === 0) {
      events.push(evt(acct.id, equity, funding, 0, 0, "healthy", notionalBefore, notionalBefore));
      continue;
    }

    // 4 + 5. call + settle — ask the agent; clamp what it pays to its free collateral.
    const offered = Math.max(0, respond({ account: acct, shortfall: call, mark }));
    const paid = Math.min(offered, acct.freeCollateral, call);
    if (paid > 0) {
      acct.freeCollateral -= paid;
      p.margin += paid;
      equity += paid;
    }
    if (equity >= params.m * reqNotional) {
      events.push(
        evt(acct.id, equity, funding, call, paid, "topped-up", notionalBefore, notionalBefore),
      );
      continue;
    }

    // 6. decrement — unpaid (or under-paid): shrink to maintenance-adequacy, or gap on E ≤ 0.
    // Re-basing the remaining position to `mark` realizes the trader's full unrealized price PnL;
    // the pool books the mirror into capital so USDC is conserved (see pool.absorb's note).
    const realizedPricePnl = pricePnl(p, mark);
    if (equity > 0) {
      const newNotional = equity / params.m; // N' = E/m
      const newQty = newNotional / mark;
      const closedQty = p.qty - newQty;
      pool.capital -= realizedPricePnl;
      // The closed slice is a forced partial close against the pool at mark (Doc 1 §3.4). Pass
      // the trader's signed-qty change; absorb() takes the opposite for the pool.
      absorb(pool, p.side === "long" ? -closedQty : closedQty, mark);
      // The decremented position keeps exactly `equity` backing `newNotional` at `m`.
      p.qty = newQty;
      p.entryMark = mark; // re-base: equity is now the margin against the smaller notional
      p.margin = equity;
      acct.realizedPnl += realizedPricePnl;
      events.push(
        evt(acct.id, equity, funding, call, paid, "decrement", notionalBefore, newNotional),
      );
    } else {
      // E ≤ 0: gap event — close fully, draw |E| from the gap fund (the only bad-debt sink).
      // The trader's realized PnL took them to `equity` (≤ 0); the pool books the mirror of the
      // price component, and the |equity| shortfall is covered by the gap fund (the bad-debt sink).
      const badDebt = -equity;
      pool.capital -= realizedPricePnl;
      drawGapFund(pool, badDebt);
      absorb(pool, -signedQty(p), mark); // unwind pool exposure
      acct.realizedPnl += realizedPricePnl;
      acct.position = flatPosition();
      events.push(evt(acct.id, equity, funding, call, paid, "gap", notionalBefore, 0));
    }
  }

  // Pool receives the mirror of all trader funding (Layer-1 pays the pool for the risk it holds).
  pool.capital += poolFundingReceived;
  pool.fundingPaid += poolFundingReceived;

  return snapshot(market, mark, s, sSmooth, rate, oiLong, oiShort, events, refusedOpens);
}

function evt(
  accountId: string,
  equity: number,
  funding: number,
  call: number,
  paid: number,
  outcome: PositionEvent["outcome"],
  notionalBefore: number,
  notionalAfter: number,
): PositionEvent {
  return { accountId, equity, funding, call, paid, outcome, notionalBefore, notionalAfter };
}

function snapshot(
  market: Market,
  mark: number,
  s: number,
  sSmooth: number,
  rate: number,
  oiLong: number,
  oiShort: number,
  events: PositionEvent[],
  refusedOpens: number,
): BlockState {
  const { pool, params } = market;
  let traderEquity = 0;
  for (const acct of market.accounts.values()) {
    traderEquity += acct.freeCollateral + equityAt(acct.position, mark);
  }
  return {
    block: market.block,
    mark,
    skew: s,
    smoothSkew: sSmooth,
    fundingRate: rate,
    oiLong,
    oiShort,
    poolCapital: pool.capital,
    poolEquity: poolEquity(pool, mark),
    poolExposure: Math.abs(pool.netQty) * mark,
    poolCap: params.k * pool.capital,
    gapFund: pool.gapFund,
    traderEquity,
    events,
    refusedOpens,
  };
}
