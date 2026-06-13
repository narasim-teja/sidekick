/**
 * Unit tests for the §4.1 funding math. These pin the exact formula shape (convex, clamped,
 * EMA-smoothed, correct sign) so the on-chain port and the sim can never silently diverge.
 */

import { describe, expect, test } from "bun:test";
import { fundingPayment, fundingRate, skew, smoothSkew } from "./funding.ts";

describe("skew", () => {
  test("balanced book is zero", () => {
    expect(skew(100, 100)).toBe(0);
  });
  test("all long is +1, all short is −1", () => {
    expect(skew(100, 0)).toBe(1);
    expect(skew(0, 100)).toBe(-1);
  });
  test("empty book is zero (no divide-by-zero)", () => {
    expect(skew(0, 0)).toBe(0);
  });
  test("normalized to [−1,1]", () => {
    expect(skew(150, 50)).toBeCloseTo(0.5, 12);
  });
});

describe("smoothSkew (EMA)", () => {
  test("λ=1 tracks instantly", () => {
    expect(smoothSkew(0.8, 0, 1)).toBe(0.8);
  });
  test("λ<1 lags toward the new value", () => {
    // λ=0.2: 0.2·1 + 0.8·0 = 0.2
    expect(smoothSkew(1, 0, 0.2)).toBeCloseTo(0.2, 12);
  });
  test("a single spike is damped (manipulation resistance)", () => {
    // From steady 0, one block of S=1 with λ=0.1 moves S_smooth only to 0.1.
    expect(smoothSkew(1, 0, 0.1)).toBeCloseTo(0.1, 12);
  });
});

describe("fundingRate (convex, clamped)", () => {
  const p = { alpha: 0.5, rMax: 0.001 };
  test("zero skew → zero rate (flat near balance)", () => {
    expect(fundingRate(0, p)).toBe(0);
  });
  test("convex S·|S| shape: doubling S_smooth quadruples the (unclamped) rate", () => {
    const big = { alpha: 0.5, rMax: 1 }; // loose clamp to see the raw shape
    const r1 = fundingRate(0.1, big);
    const r2 = fundingRate(0.2, big);
    expect(r2 / r1).toBeCloseTo(4, 6);
  });
  test("sign follows skew: long-heavy → positive, short-heavy → negative", () => {
    expect(fundingRate(0.5, { alpha: 0.5, rMax: 1 })).toBeGreaterThan(0);
    expect(fundingRate(-0.5, { alpha: 0.5, rMax: 1 })).toBeLessThan(0);
  });
  test("clamped to ±r_max", () => {
    expect(fundingRate(1, p)).toBe(p.rMax);
    expect(fundingRate(-1, p)).toBe(-p.rMax);
  });
});

describe("fundingPayment", () => {
  test("scales with notional, rate, and Δt/T", () => {
    // N=10000, rate=0.001, Δt=2, T=8h=28800 → 10000·0.001·(2/28800)
    const pay = fundingPayment(10_000, 0.001, 2, 28_800);
    expect(pay).toBeCloseTo(10_000 * 0.001 * (2 / 28_800), 12);
  });
  test("zero rate → zero payment", () => {
    expect(fundingPayment(10_000, 0)).toBe(0);
  });
});
