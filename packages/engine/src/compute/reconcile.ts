/**
 * Layer A reconciliation — the off-chain §4.3 compute that mirrors `PerpEngine.checkpoint` exactly
 * (fixed-point, bigint). It is a PURE prediction over a read snapshot: given the new mark, the live
 * book, and each position's margin + free collateral, it computes the per-position funding, margin
 * call, and decrement/gap outcome that the on-chain `checkpoint` will produce. The engine uses this
 * to (a) emit Layer B margin-call/funding deltas, and (b) stream per-block state — while the actual
 * authoritative state transition is the `checkpoint` txn it then triggers.
 *
 * It reproduces the contract's ordering and arithmetic step-for-step (the funding-cash floor at
 * available margin, the post-funding health check, the decrement vs gap branch), using the
 * `src/fixed` ports that the parity test proves equal the Solidity. So the prediction equals the
 * on-chain result block-for-block — no float drift (Doc 1 §4.3 anti-double-count).
 *
 * @see packages/contracts/src/PerpEngine.sol (_reconcileOne / _decrementOrGap — the exact mirror)
 */

import type { OnChainPosition } from "../chain/venue.ts";
import { applyDecrement, type DecrementKind, marginCall } from "../fixed/decrement.ts";
import { fundingPayment, fundingRate, skew, smoothSkew } from "../fixed/funding.ts";
import type { FixedMarketParams } from "../fixed/params.ts";
import { fundingParamsOf } from "../fixed/params.ts";

/** A position with its account + the free collateral available to answer a call (the read snapshot). */
export interface ReconcileInput {
  account: string;
  position: OnChainPosition;
  /** Free collateral the position's account can draw on to answer a margin call (USDC 6dp). */
  freeCollateral: bigint;
}

/** Per-position reconciliation outcome — the prediction for the dashboard + Layer B. */
export interface PositionReconcile {
  account: string;
  /** Position side (carried from the read, not inferred). */
  side: "long" | "short";
  /** Equity after mark + funding, before any call/decrement (USDC 6dp, signed). */
  equity: bigint;
  /** Funding cashflow to the position this block (+received / −paid), intended (USDC 6dp, signed). */
  funding: bigint;
  /** Margin-call shortfall requested (USDC 6dp; 0 if healthy). */
  call: bigint;
  /** Amount the account can/does pay toward the call from free collateral (USDC 6dp). */
  paid: bigint;
  outcome: "healthy" | "topped-up" | DecrementKind;
  notionalBefore: bigint;
  notionalAfter: bigint;
}

/** The block-level reconciliation result over all positions. */
export interface BlockReconcile {
  /** Raw instantaneous skew S (WAD). */
  skew: bigint;
  /** EMA-smoothed skew carried into next block (WAD). */
  smoothSkew: bigint;
  /** Per-period funding rate (WAD). */
  fundingRate: bigint;
  oiLong: bigint;
  oiShort: bigint;
  positions: PositionReconcile[];
  /** Net funding the pool receives this block (= −Σ trader funding), USDC 6dp. */
  poolFundingReceived: bigint;
}

/** Block cadence Δt and funding period T (seconds), matching the on-chain immutables. */
export interface Cadence {
  blockSeconds: bigint;
  periodSeconds: bigint;
}

/** Current notional at `mark`: entryNotional · mark / entryMark (USDC 6dp). Mirrors `_notionalAt`. */
export function notionalAt(p: OnChainPosition, mark: bigint): bigint {
  if (p.side === "flat") return 0n;
  return (p.entryNotional * mark) / p.entryMark;
}

/** Unrealized price PnL at `mark` (USDC 6dp, signed). Mirrors `_pricePnl`. */
export function pricePnl(p: OnChainPosition, mark: bigint): bigint {
  if (p.side === "flat") return 0n;
  const diff = mark - p.entryMark;
  const magnitude = (p.entryNotional * diff) / p.entryMark;
  return p.side === "long" ? magnitude : -magnitude;
}

/** Equity at `mark`: margin + unrealized price PnL (USDC 6dp, signed). Mirrors `_equityAt`. */
export function equityAt(p: OnChainPosition, mark: bigint): bigint {
  return p.margin + pricePnl(p, mark);
}

/**
 * Apply funding to a position's margin and return the cash the POOL receives (= −Δmargin), mirroring
 * `PerpEngine._applyFunding`: funding received credits margin in full; funding paid is floored at the
 * available margin cash (a position cannot pay funding out of unrealized PnL on-chain). Mutates a
 * COPY's margin via the returned `newMargin` (callers don't mutate the read snapshot).
 */
export function applyFunding(
  margin: bigint,
  funding: bigint,
): { newMargin: bigint; poolReceives: bigint } {
  if (funding >= 0n) {
    return { newMargin: margin + funding, poolReceives: -funding };
  }
  const owed = -funding;
  const cashPaid = owed <= margin ? owed : margin; // floor at available margin
  return { newMargin: margin - cashPaid, poolReceives: cashPaid };
}

/** Total open interest split long/short at `mark` (USDC 6dp). Mirrors `_openInterest`. */
export function openInterest(
  inputs: ReconcileInput[],
  mark: bigint,
): { oiLong: bigint; oiShort: bigint } {
  let oiLong = 0n;
  let oiShort = 0n;
  for (const { position } of inputs) {
    if (position.side === "long") oiLong += notionalAt(position, mark);
    else if (position.side === "short") oiShort += notionalAt(position, mark);
  }
  return { oiLong, oiShort };
}

/**
 * Run the off-chain §4.3 reconciliation for one block. Pure: it does NOT mutate the inputs and does
 * NOT touch the chain — it predicts what `checkpoint(marketId, mark, accounts)` will do, in the same
 * integer units and order. The funding rate is computed once from the post-mark book, then applied
 * per position (exactly as the contract does).
 */
export function reconcileBlock(
  inputs: ReconcileInput[],
  mark: bigint,
  params: FixedMarketParams,
  smoothSkewPrev: bigint,
  cadence: Cadence,
): BlockReconcile {
  const { oiLong, oiShort } = openInterest(inputs, mark);
  const s = skew(oiLong, oiShort);
  const sSmooth = smoothSkew(s, smoothSkewPrev, params.lambda);
  const rate = fundingRate(sSmooth, fundingParamsOf(params));

  const positions: PositionReconcile[] = [];
  let poolFundingReceived = 0n;

  for (const input of inputs) {
    const p = input.position;
    if (p.side === "flat") continue;
    const notionalBefore = p.entryNotional;
    const notionalNow = notionalAt(p, mark);

    // 2. fund — magnitude N·rate·(Δt/T); sign: rate>0 → longs pay. Cash floored at available margin.
    const magnitude = fundingPayment(
      notionalNow,
      rate,
      cadence.blockSeconds,
      cadence.periodSeconds,
    );
    const sideSign = p.side === "long" ? 1n : -1n;
    const funding = -sideSign * magnitude; // + received, − paid (intended)
    const { newMargin, poolReceives } = applyFunding(p.margin, funding);
    poolFundingReceived += poolReceives;

    // Equity on the post-funding margin at the new mark.
    const fundedPos: OnChainPosition = { ...p, margin: newMargin };
    let equity = equityAt(fundedPos, mark);

    // 3. check — healthy iff E ≥ m·N (post-funding).
    const call = marginCall(equity, notionalNow, params.m);
    if (call === 0n) {
      positions.push({
        account: input.account,
        side: p.side,
        equity,
        funding,
        call: 0n,
        paid: 0n,
        outcome: "healthy",
        notionalBefore,
        notionalAfter: notionalBefore,
      });
      continue;
    }

    // 4 + 5. call + settle — pay min(call, freeCollateral) (the on-chain settle from free collateral).
    const paid = call <= input.freeCollateral ? call : input.freeCollateral;
    if (paid > 0n) equity += paid;

    // Health after the top-up uses the same fixed-point predicate the contract does (isHealthy via
    // marginCall == 0). A full pay restores health; a dark/under-paying account falls through.
    if (marginCall(equity, notionalNow, params.m) === 0n) {
      positions.push({
        account: input.account,
        side: p.side,
        equity,
        funding,
        call,
        paid,
        outcome: "topped-up",
        notionalBefore,
        notionalAfter: notionalBefore,
      });
      continue;
    }

    // 6. decrement — unpaid/under-paid: shrink to maintenance-adequacy, or gap on E ≤ 0.
    const o = applyDecrement(equity, notionalNow, params.m);
    positions.push({
      account: input.account,
      side: p.side,
      equity,
      funding,
      call,
      paid,
      outcome: o.kind,
      notionalBefore,
      notionalAfter:
        o.kind === "decrement" ? o.newNotional : o.kind === "gap" ? 0n : notionalBefore,
    });
  }

  return {
    skew: s,
    smoothSkew: sSmooth,
    fundingRate: rate,
    oiLong,
    oiShort,
    positions,
    poolFundingReceived,
  };
}
