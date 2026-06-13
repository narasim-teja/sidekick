/**
 * Units tests — the conversions at the chain boundary (USDC 6dp ⇄ string, WAD 18dp ⇄ string,
 * float → WAD with the same 12-decimal rounding `gen-params.ts` uses). A bug here would silently
 * misprice everything, so they're pinned.
 */

import { describe, expect, test } from "bun:test";
import {
  floatToUsdc,
  floatToWad,
  formatUsdc,
  formatWad,
  parseUsdc,
  USDC_ONE,
  WAD,
} from "./units.ts";

describe("parseUsdc / formatUsdc", () => {
  test("round-trips whole and fractional amounts", () => {
    expect(parseUsdc("100")).toBe(100n * USDC_ONE);
    expect(parseUsdc("100.5")).toBe(100_500_000n);
    expect(parseUsdc("0.003472")).toBe(3_472n);
    expect(formatUsdc(100_500_000n)).toBe("100.5");
    expect(formatUsdc(3_472n)).toBe("0.003472");
    expect(formatUsdc(0n)).toBe("0");
  });

  test("formats negative amounts", () => {
    expect(formatUsdc(-3_472n)).toBe("-0.003472");
  });

  test("rejects more than 6 decimals", () => {
    expect(() => parseUsdc("1.1234567")).toThrow();
  });

  test("rejects garbage", () => {
    expect(() => parseUsdc("abc")).toThrow();
    expect(() => parseUsdc("1.2.3")).toThrow();
  });
});

describe("formatWad", () => {
  test("formats an 18dp price", () => {
    expect(formatWad(70_627_228_485_675_004_000_000n)).toBe("70627.228485675004");
    expect(formatWad(WAD)).toBe("1");
    expect(formatWad(WAD / 2n)).toBe("0.5");
  });
});

describe("floatToWad (matches gen-params 12-decimal rounding)", () => {
  test("the swept constants land on the exact generated values", () => {
    expect(floatToWad(0.01)).toBe(10_000_000_000_000_000n); // m = 0.01e18
    expect(floatToWad(0.0005)).toBe(500_000_000_000_000n); // α / r_max = 0.0005e18
    expect(floatToWad(0.08)).toBe(80_000_000_000_000_000n); // λ = 0.08e18
  });

  test("clears float dust (0.1 + 0.2 style)", () => {
    expect(floatToWad(0.1 + 0.2)).toBe(300_000_000_000_000_000n); // 0.3e18, not 0.30000000000000004
  });
});

describe("floatToUsdc", () => {
  test("rounds to 6dp atomic", () => {
    expect(floatToUsdc(100)).toBe(100n * USDC_ONE);
    expect(floatToUsdc(0.5)).toBe(500_000n);
  });
});
