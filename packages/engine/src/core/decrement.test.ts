/**
 * Unit tests for the §4.2 decrement rule, including the worked example from Doc 1 §4.2.
 */

import { describe, expect, test } from "bun:test";
import { decrement, isHealthy, marginCall } from "./decrement.ts";

describe("isHealthy", () => {
  test("healthy iff equity ≥ m·N", () => {
    expect(isHealthy(100, 10_000, 0.01)).toBe(true); // E = m·N exactly
    expect(isHealthy(99, 10_000, 0.01)).toBe(false);
  });
});

describe("marginCall", () => {
  test("zero when healthy", () => {
    expect(marginCall(150, 10_000, 0.01)).toBe(0);
  });
  test("equals the shortfall m·N − E when short", () => {
    expect(marginCall(60, 10_000, 0.01)).toBeCloseTo(40, 12); // need 100, have 60
  });
});

describe("decrement (Doc 1 §4.2)", () => {
  test("healthy position is untouched", () => {
    expect(decrement(150, 10_000, 0.01)).toEqual({ kind: "healthy" });
  });

  test("worked example: N=$10k, m=1%, E erodes to $60 → N'=$6k", () => {
    const out = decrement(60, 10_000, 0.01);
    expect(out.kind).toBe("decrement");
    if (out.kind !== "decrement") throw new Error("unreachable");
    expect(out.newNotional).toBeCloseTo(6_000, 9); // 60/0.01
    expect(out.closedNotional).toBeCloseTo(4_000, 9);
  });

  test("after decrement, the new equity exactly backs the new notional at m", () => {
    const E = 60;
    const out = decrement(E, 10_000, 0.01);
    if (out.kind !== "decrement") throw new Error("unreachable");
    // E is now the margin against N'; E / N' = m.
    expect(E / out.newNotional).toBeCloseTo(0.01, 12);
  });

  test("E ≤ 0 is a gap event drawing |E| of bad debt", () => {
    const out = decrement(-25, 10_000, 0.01);
    expect(out).toEqual({ kind: "gap", badDebt: 25 });
  });
});
