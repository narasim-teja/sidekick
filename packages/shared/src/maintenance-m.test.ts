/**
 * Tests for the demo maintenance-margin knob (`DEMO_MAINTENANCE_M`). This is the single config value
 * that lifts the margin-call line into reach so the x402 nanopayment flow fires on a gentle drift; it
 * must default to the swept production 1% (so production is untouched) and override cleanly. Pure —
 * everything is a function of an env map.
 */

import { describe, expect, test } from "bun:test";
import { getEffectiveMarket, getMarket, MARKET_SYMBOLS, resolveMaintenanceM } from "./markets.ts";

const SWEPT_M = getMarket("ETH-PERP").params.m; // the production default (currently 0.01)

describe("resolveMaintenanceM", () => {
  test("defaults to the swept production m when unset or blank", () => {
    expect(resolveMaintenanceM({})).toBe(SWEPT_M);
    expect(resolveMaintenanceM({ DEMO_MAINTENANCE_M: "" })).toBe(SWEPT_M);
    expect(resolveMaintenanceM({ DEMO_MAINTENANCE_M: "   " })).toBe(SWEPT_M);
  });

  test("applies a valid fractional override", () => {
    expect(resolveMaintenanceM({ DEMO_MAINTENANCE_M: "0.10" })).toBe(0.1);
    expect(resolveMaintenanceM({ DEMO_MAINTENANCE_M: "0.05" })).toBe(0.05);
  });

  test("rejects out-of-range or non-numeric values (fail fast, never silently)", () => {
    for (const bad of ["0", "1", "1.5", "-0.1", "10", "abc", "%5"]) {
      expect(() => resolveMaintenanceM({ DEMO_MAINTENANCE_M: bad })).toThrow();
    }
  });
});

describe("getEffectiveMarket", () => {
  test("returns the pristine swept config when no override is set", () => {
    const base = getMarket("ETH-PERP");
    const eff = getEffectiveMarket("ETH-PERP", {});
    expect(eff.params.m).toBe(base.params.m);
    // Untouched: identical object (no needless copy when there's nothing to override).
    expect(eff).toBe(base);
  });

  test("overrides ONLY m for every market, leaving the other swept params intact", () => {
    const base = getMarket("ETH-PERP");
    const eff = getEffectiveMarket("ETH-PERP", { DEMO_MAINTENANCE_M: "0.10" });
    expect(eff.params.m).toBe(0.1);
    expect(eff.params.alpha).toBe(base.params.alpha);
    expect(eff.params.lambda).toBe(base.params.lambda);
    expect(eff.params.rMax).toBe(base.params.rMax);
    expect(eff.params.k).toBe(base.params.k);
    // The override applies uniformly across the whole market set.
    for (const sym of MARKET_SYMBOLS) {
      expect(getEffectiveMarket(sym, { DEMO_MAINTENANCE_M: "0.10" }).params.m).toBe(0.1);
    }
  });

  test("does not mutate the shared swept DEFAULT_PARAMS (override is a copy)", () => {
    getEffectiveMarket("ETH-PERP", { DEMO_MAINTENANCE_M: "0.10" });
    // Reading the base again still shows the swept value — the override never wrote through.
    expect(getMarket("ETH-PERP").params.m).toBe(SWEPT_M);
  });
});
