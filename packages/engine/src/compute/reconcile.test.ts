/**
 * Reconciliation tests — the off-chain §4.3 Layer-A compute. These assert the engine's prediction
 * matches the documented worked examples and the on-chain semantics: funding signs + the cash
 * floor, the post-funding health check, and the decrement/gap branches. Because `reconcileBlock`
 * is built on the parity-tested `src/fixed` math, matching these values means matching the chain.
 *
 * (The end-to-end equality with a real `PerpEngine.checkpoint` is verified live via
 * `bun run live:tick` — confirmed: the engine's checkpoint advanced on-chain smoothSkewPrev to the
 * exact value this compute predicts.)
 */

import { describe, expect, test } from "bun:test";
import { getMarket } from "@sidekick/shared";
import type { OnChainPosition } from "../chain/venue.ts";
import { toFixedParams } from "../fixed/params.ts";
import {
  applyFunding,
  equityAt,
  notionalAt,
  pricePnl,
  type ReconcileInput,
  reconcileBlock,
} from "./reconcile.ts";

const USDC = 1_000_000n;
const WAD = 1_000_000_000_000_000_000n;
const PARAMS = toFixedParams(getMarket("BTC-PERP").params); // m=0.01, α=rMax=0.0005, λ=0.08, k=3
const CADENCE = { blockSeconds: 2n, periodSeconds: 28_800n };

/** A long position helper: notional N (USDC), entry mark (USD), margin (USDC). */
function longPos(notional: bigint, markUsd: bigint, margin: bigint): OnChainPosition {
  return { side: "long", entryNotional: notional, entryMark: markUsd * WAD, margin };
}
function shortPos(notional: bigint, markUsd: bigint, margin: bigint): OnChainPosition {
  return { side: "short", entryNotional: notional, entryMark: markUsd * WAD, margin };
}

describe("position math (mirrors PerpEngine view helpers)", () => {
  test("notionalAt scales with mark", () => {
    const p = longPos(10_000n * USDC, 70_000n, 1_000n * USDC);
    expect(notionalAt(p, 70_000n * WAD)).toBe(10_000n * USDC);
    expect(notionalAt(p, 77_000n * WAD)).toBe(11_000n * USDC); // +10% mark → +10% notional
  });

  test("pricePnl: long profits on a rise, short profits on a fall", () => {
    const long = longPos(10_000n * USDC, 70_000n, 1_000n * USDC);
    const short = shortPos(10_000n * USDC, 70_000n, 1_000n * USDC);
    expect(pricePnl(long, 77_000n * WAD)).toBe(1_000n * USDC); // +10% on 10k = +1k
    expect(pricePnl(short, 77_000n * WAD)).toBe(-1_000n * USDC);
    expect(pricePnl(long, 63_000n * WAD)).toBe(-1_000n * USDC); // −10% on 10k = −1k
  });

  test("equityAt = margin + pricePnl", () => {
    const p = longPos(10_000n * USDC, 70_000n, 1_000n * USDC);
    expect(equityAt(p, 77_000n * WAD)).toBe(2_000n * USDC); // 1k margin + 1k pnl
  });

  test("applyFunding floors a payment at available margin (no paying out of unrealized PnL)", () => {
    // Funding received credits margin in full; pool's claim drops by that amount.
    expect(applyFunding(1_000n * USDC, 5n * USDC)).toEqual({
      newMargin: 1_005n * USDC,
      poolReceives: -5n * USDC,
    });
    // Funding owed beyond margin is floored at margin; pool receives only the cash that existed.
    expect(applyFunding(3n * USDC, -10n * USDC)).toEqual({
      newMargin: 0n,
      poolReceives: 3n * USDC,
    });
  });
});

describe("reconcileBlock — §4.3 outcomes", () => {
  test("a healthy, well-margined book: everyone healthy, funding is a zero-sum transfer", () => {
    const inputs: ReconcileInput[] = [
      {
        account: "0xLong",
        position: longPos(100_000n * USDC, 70_000n, 20_000n * USDC),
        freeCollateral: 0n,
      },
      {
        account: "0xShort",
        position: shortPos(60_000n * USDC, 70_000n, 20_000n * USDC),
        freeCollateral: 0n,
      },
    ];
    const r = reconcileBlock(inputs, 70_000n * WAD, PARAMS, 0n, CADENCE);
    expect(r.oiLong).toBe(100_000n * USDC);
    expect(r.oiShort).toBe(60_000n * USDC);
    expect(r.skew).toBeGreaterThan(0n); // net long
    for (const p of r.positions) expect(p.outcome).toBe("healthy");
    // Conservation of the funding transfer: pool receives exactly −Σ(trader funding).
    const traderFunding = r.positions.reduce((acc, p) => acc + p.funding, 0n);
    expect(r.poolFundingReceived).toBe(-traderFunding);
  });

  test("net-long book → longs pay funding, shorts receive (rate>0 sign convention)", () => {
    const inputs: ReconcileInput[] = [
      {
        account: "0xLong",
        position: longPos(200_000n * USDC, 70_000n, 50_000n * USDC),
        freeCollateral: 0n,
      },
      {
        account: "0xShort",
        position: shortPos(20_000n * USDC, 70_000n, 50_000n * USDC),
        freeCollateral: 0n,
      },
    ];
    // Pre-seed smoothSkew high so the rate is non-trivial on a big book.
    const r = reconcileBlock(inputs, 70_000n * WAD, PARAMS, WAD, CADENCE);
    expect(r.fundingRate).toBeGreaterThan(0n);
    const long = r.positions.find((p) => p.side === "long");
    const short = r.positions.find((p) => p.side === "short");
    expect(long?.funding).toBeLessThan(0n); // long pays
    expect(short?.funding).toBeGreaterThan(0n); // short receives
  });

  test("an unpaid, under-margined long decrements toward maintenance-adequacy", () => {
    // Long $100k @ 70k, mark drops 5% → pricePnl −$5k; margin $5.5k → equity ~$0.5k < m·N($1k post-drop).
    // Dark (freeCollateral 0) → no top-up → decrement.
    const inputs: ReconcileInput[] = [
      {
        account: "0xDark",
        position: longPos(100_000n * USDC, 70_000n, 5_500n * USDC),
        freeCollateral: 0n,
      },
    ];
    const markDown = 66_500n * WAD; // −5%
    const r = reconcileBlock(inputs, markDown, PARAMS, 0n, CADENCE);
    const p = r.positions[0];
    expect(p?.outcome).toBe("decrement");
    expect(p?.paid).toBe(0n);
    expect(BigInt(p?.notionalAfter ?? 0n)).toBeLessThan(p?.notionalBefore ?? 0n); // shrank
  });

  test("a paying account tops up and stays healthy (not a decrement)", () => {
    const inputs: ReconcileInput[] = [
      // Same under-margined long, but with free collateral to answer the call.
      {
        account: "0xLive",
        position: longPos(100_000n * USDC, 70_000n, 5_500n * USDC),
        freeCollateral: 50_000n * USDC,
      },
    ];
    const r = reconcileBlock(inputs, 66_500n * WAD, PARAMS, 0n, CADENCE);
    const p = r.positions[0];
    expect(p?.outcome).toBe("topped-up");
    expect(p?.paid).toBeGreaterThan(0n);
    expect(p?.notionalAfter).toBe(p?.notionalBefore); // notional unchanged — it cured margin
  });

  test("a single-block gap drives equity ≤ 0 → gap branch (full close)", () => {
    // Thin 50× long: $100k @ 70k, margin $2k. A −5% gap is −$5k → equity ≈ −$3k ≤ 0.
    const inputs: ReconcileInput[] = [
      {
        account: "0xGap",
        position: longPos(100_000n * USDC, 70_000n, 2_000n * USDC),
        freeCollateral: 0n,
      },
    ];
    const r = reconcileBlock(inputs, 66_500n * WAD, PARAMS, 0n, CADENCE);
    const p = r.positions[0];
    expect(p?.outcome).toBe("gap");
    expect(p?.equity).toBeLessThanOrEqual(0n);
    expect(p?.notionalAfter).toBe(0n); // closed fully
  });

  test("empty book: zero skew, zero rate, no positions", () => {
    const r = reconcileBlock([], 70_000n * WAD, PARAMS, 0n, CADENCE);
    expect(r.skew).toBe(0n);
    expect(r.fundingRate).toBe(0n);
    expect(r.positions).toHaveLength(0);
    expect(r.poolFundingReceived).toBe(0n);
  });
});
