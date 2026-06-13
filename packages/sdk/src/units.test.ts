/**
 * Tests for the SDK's unit boundary (units.ts). These are the conversions the SDK applies when a
 * consumer's human decimal string crosses to the venue's 6dp/WAD integers — they must match the
 * on-chain representation exactly (the engine's canonical port is re-used, so this mainly guards the
 * SDK-specific helpers: leverage→notional sugar and the WAD mark parse).
 */

import { describe, expect, test } from "bun:test";
import { formatUsdc, notionalFromLeverage, parseMarkWad, parseUsdc, WAD } from "./units.ts";

describe("notionalFromLeverage", () => {
  test("notional = collateral × leverage (integer-exact)", () => {
    expect(formatUsdc(notionalFromLeverage("20", 10))).toBe("200");
    expect(formatUsdc(notionalFromLeverage("5", 1))).toBe("5");
    expect(formatUsdc(notionalFromLeverage("100", 3))).toBe("300");
  });

  test("handles fractional leverage without float dust", () => {
    expect(formatUsdc(notionalFromLeverage("10", 2.5))).toBe("25");
    expect(formatUsdc(notionalFromLeverage("3", 1.5))).toBe("4.5");
  });

  test("rejects non-positive leverage", () => {
    expect(() => notionalFromLeverage("10", 0)).toThrow();
    expect(() => notionalFromLeverage("10", -1)).toThrow();
  });

  test("agrees with parseUsdc on the collateral leg at 1x", () => {
    expect(notionalFromLeverage("42.5", 1)).toBe(parseUsdc("42.5"));
  });
});

describe("parseMarkWad", () => {
  test("parses an integer price to WAD", () => {
    expect(parseMarkWad("70000")).toBe(70_000n * WAD);
  });

  test("parses a fractional price to WAD", () => {
    expect(parseMarkWad("70627.5")).toBe(70_627n * WAD + WAD / 2n);
  });

  test("pads short fractions correctly", () => {
    // 0.000001 → 1e12 in WAD (1e18 * 1e-6).
    expect(parseMarkWad("0.000001")).toBe(1_000_000_000_000n);
  });

  test("rejects malformed prices and over-precision", () => {
    expect(() => parseMarkWad("abc")).toThrow();
    expect(() => parseMarkWad("1.2.3")).toThrow();
    expect(() => parseMarkWad(`1.${"0".repeat(19)}`)).toThrow();
  });
});
