/**
 * Fixed-point parity test — the keystone of Phase 3 correctness.
 *
 * Asserts the TypeScript bigint math (`src/fixed/*`) reproduces the on-chain Solidity libraries
 * (`packages/contracts/src/lib/*`) BIT-FOR-BIT, over a fixture of vectors emitted by
 * `script/GenParityVectors.s.sol` (run via `bun run gen:parity` / `forge script`). If this passes,
 * the engine's off-chain per-block compute equals exactly what `PerpEngine.checkpoint` produces on
 * Arc — so the off-chain prediction never drifts from on-chain truth (the conservation /
 * double-count guarantee, Doc 1 §4.3).
 *
 * The fixture is committed, so this test is hermetic (no live RPC). Regenerate it whenever the
 * Solidity libs change.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDecrement, isHealthy, marginCall } from "./decrement.ts";
import { fundingPayment, fundingRate, skew, smoothSkew } from "./funding.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../../../contracts/test/fixtures/parity-vectors.json");

interface Vectors {
  skew: { oiLong: string | number; oiShort: string | number; out: string | number }[];
  smoothSkew: { s: string; prev: string; lambda: string; out: string }[];
  fundingRate: { sSmooth: string; alpha: string; rMax: string; out: string }[];
  fundingPayment: { notional: string; rate: string; out: string }[];
  isHealthy: { equity: string; notional: string; m: string; out: boolean }[];
  marginCall: { equity: string; notional: string; m: string; out: string }[];
  applyDecrement: {
    equity: string;
    notional: string;
    m: string;
    kind: number;
    newNotional: string;
    closedNotional: string;
    badDebt: string;
  }[];
  _meta: { block_seconds: number; period_seconds: number };
}

const vectors = JSON.parse(readFileSync(FIXTURE, "utf8")) as Vectors;
const BLOCK_SECONDS = BigInt(vectors._meta.block_seconds);
const PERIOD_SECONDS = BigInt(vectors._meta.period_seconds);
const KINDS = ["healthy", "decrement", "gap"] as const; // matches Decrement.Kind enum order

describe("fixed-point parity with on-chain Solidity libs", () => {
  test("skew() reproduces every on-chain vector", () => {
    for (const v of vectors.skew) {
      expect(skew(BigInt(v.oiLong), BigInt(v.oiShort))).toBe(BigInt(v.out));
    }
  });

  test("smoothSkew() reproduces every on-chain vector", () => {
    for (const v of vectors.smoothSkew) {
      expect(smoothSkew(BigInt(v.s), BigInt(v.prev), BigInt(v.lambda))).toBe(BigInt(v.out));
    }
  });

  test("fundingRate() reproduces every on-chain vector (convex + clamp)", () => {
    for (const v of vectors.fundingRate) {
      const params = { alpha: BigInt(v.alpha), rMax: BigInt(v.rMax), lambda: 0n };
      expect(fundingRate(BigInt(v.sSmooth), params)).toBe(BigInt(v.out));
    }
  });

  test("fundingPayment() reproduces every on-chain vector (truncation-exact)", () => {
    for (const v of vectors.fundingPayment) {
      expect(
        fundingPayment(BigInt(v.notional), BigInt(v.rate), BLOCK_SECONDS, PERIOD_SECONDS),
      ).toBe(BigInt(v.out));
    }
  });

  test("isHealthy() reproduces every on-chain vector", () => {
    for (const v of vectors.isHealthy) {
      expect(isHealthy(BigInt(v.equity), BigInt(v.notional), BigInt(v.m))).toBe(v.out);
    }
  });

  test("marginCall() reproduces every on-chain vector", () => {
    for (const v of vectors.marginCall) {
      expect(marginCall(BigInt(v.equity), BigInt(v.notional), BigInt(v.m))).toBe(BigInt(v.out));
    }
  });

  test("applyDecrement() reproduces every on-chain vector (kind + amounts)", () => {
    for (const v of vectors.applyDecrement) {
      const o = applyDecrement(BigInt(v.equity), BigInt(v.notional), BigInt(v.m));
      expect(o.kind).toBe(KINDS[v.kind] as typeof o.kind);
      expect(o.newNotional).toBe(BigInt(v.newNotional));
      expect(o.closedNotional).toBe(BigInt(v.closedNotional));
      expect(o.badDebt).toBe(BigInt(v.badDebt));
    }
  });

  test("fixture is non-trivial (guards against an empty/stale fixture silently passing)", () => {
    expect(vectors.skew.length).toBeGreaterThanOrEqual(5);
    expect(vectors.fundingRate.length).toBeGreaterThanOrEqual(8);
    expect(vectors.applyDecrement.length).toBeGreaterThanOrEqual(5);
  });
});

describe("fixed-point known values (self-documenting, independent of the fixture)", () => {
  const WAD = 1_000_000_000_000_000_000n;
  const USDC = 1_000_000n;
  const M = 10_000_000_000_000_000n; // 0.01e18
  const ALPHA = 500_000_000_000_000n; // 0.0005e18
  const R_MAX = 500_000_000_000_000n;
  const LAMBDA = 80_000_000_000_000_000n; // 0.08e18

  test("skew of an all-long book is +1 (WAD)", () => {
    expect(skew(100_000n * USDC, 0n)).toBe(WAD);
  });

  test("one EMA step from balance with S=1 is λ = 0.08", () => {
    expect(smoothSkew(WAD, 0n, LAMBDA)).toBe(80_000_000_000_000_000n);
  });

  test("rate at saturation S=1 equals rMax (α scales with rMax)", () => {
    expect(fundingRate(WAD, { alpha: ALPHA, rMax: R_MAX, lambda: LAMBDA })).toBe(R_MAX);
  });

  test("100k @ rMax for one 2s block ≈ 0.003472 USDC (3472 atomic, truncated)", () => {
    expect(fundingPayment(100_000n * USDC, R_MAX, 2n, 28_800n)).toBe(3472n);
  });

  test("decrement: E=$60 at m=1% shrinks N from $10k to $6k", () => {
    const o = applyDecrement(60n * USDC, 10_000n * USDC, M);
    expect(o.kind).toBe("decrement");
    expect(o.newNotional).toBe(6_000n * USDC);
    expect(o.closedNotional).toBe(4_000n * USDC);
  });

  test("gap: E=-$5 closes fully and books $5 bad debt", () => {
    const o = applyDecrement(-5n * USDC, 10_000n * USDC, M);
    expect(o.kind).toBe("gap");
    expect(o.badDebt).toBe(5n * USDC);
  });
});
