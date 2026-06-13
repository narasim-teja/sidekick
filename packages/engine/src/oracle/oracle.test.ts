/**
 * Oracle-layer tests: synthetic determinism, `NotFound` detection, and the resilient
 * primary→fallback latch + re-probe. No live RPC — the Stork leg is faked so the test is hermetic
 * (a separate `live:oracle` script reads the real Arc feed).
 */

import { describe, expect, test } from "bun:test";
import type { MarkPrice, OracleAdapter } from "@sidekick/shared";
import { WAD } from "../fixed/units.ts";
import { ResilientOracle } from "./index.ts";
import { isStorkNotFound, StorkNotFoundError, type StorkOracle } from "./stork.ts";
import { SyntheticOracle } from "./synthetic.ts";

describe("SyntheticOracle", () => {
  test("is deterministic for a given seed (same asset → same path)", async () => {
    const a = new SyntheticOracle("ETHUSD");
    const b = new SyntheticOracle("ETHUSD");
    const pa = [await a.getMark(), await a.getMark(), await a.getMark()];
    const pb = [await b.getMark(), await b.getMark(), await b.getMark()];
    expect(pa.map((m) => m.price18)).toEqual(pb.map((m) => m.price18));
  });

  test("different assets diverge", async () => {
    const eth = await new SyntheticOracle("ETHUSD").getMark();
    const sol = await new SyntheticOracle("SOLUSD").getMark();
    expect(eth.price18).not.toBe(sol.price18);
  });

  test("walks smoothly around its anchor (no wild jumps in a block)", async () => {
    const o = new SyntheticOracle("ETHUSD"); // anchor 3500
    const first = await o.getMark();
    const second = await o.getMark();
    const drift = Number(second.price18 - first.price18) / Number(first.price18);
    expect(Math.abs(drift)).toBeLessThan(0.01); // < 1% block-to-block
  });

  test("emits a positive WAD-18dp price", async () => {
    const m = await new SyntheticOracle("LINKUSD").getMark();
    expect(m.price18).toBeGreaterThan(0n);
    // LINK anchor ~18 → price18 on the order of 18e18.
    expect(m.price18 / WAD).toBeGreaterThan(1n);
  });
});

describe("isStorkNotFound", () => {
  test("matches the NotFound selector", () => {
    expect(isStorkNotFound(new Error("execution reverted, data: 0xc5723b51"))).toBe(true);
  });
  test("matches a StorkNotFoundError", () => {
    expect(isStorkNotFound(new StorkNotFoundError("ETHUSD", "no value"))).toBe(true);
  });
  test("does not match an unrelated RPC error", () => {
    expect(isStorkNotFound(new Error("connection refused"))).toBe(false);
  });
});

/** A fake StorkOracle that either returns a fixed mark or throws NotFound, with a call counter. */
function fakeStork(behavior: "live" | "notfound"): { oracle: OracleAdapter; calls: () => number } {
  let calls = 0;
  const oracle: OracleAdapter = {
    source: "stork",
    getMark(): Promise<MarkPrice> {
      calls += 1;
      if (behavior === "notfound") {
        return Promise.reject(new StorkNotFoundError("TESTUSD", "not pushed"));
      }
      return Promise.resolve({
        asset: "TESTUSD",
        price18: 70_000n * WAD,
        timestampMs: 1_700_000_000_000,
        source: "stork",
      });
    },
  };
  return { oracle, calls: () => calls };
}

describe("ResilientOracle", () => {
  test("serves the live Stork mark when the feed is pushed", async () => {
    const stork = fakeStork("live");
    const o = new ResilientOracle(
      "TESTUSD",
      stork.oracle as StorkOracle,
      new SyntheticOracle("TESTUSD"),
    );
    const m = await o.getMark();
    expect(m.provenance).toBe("stork-live");
    expect(m.price18).toBe(70_000n * WAD);
    expect(o.isSynthetic).toBe(false);
  });

  test("falls back to synthetic on NotFound and latches (no repeated reverting reads)", async () => {
    const stork = fakeStork("notfound");
    const o = new ResilientOracle(
      "TESTUSD",
      stork.oracle as StorkOracle,
      new SyntheticOracle("TESTUSD"),
      150,
    );
    const m1 = await o.getMark();
    expect(m1.provenance).toBe("synthetic-fallback");
    expect(o.isSynthetic).toBe(true);
    // Subsequent reads stay synthetic without hitting the (reverting) Stork path again…
    await o.getMark();
    await o.getMark();
    expect(stork.calls()).toBe(1); // only the initial probe touched Stork
  });

  test("re-probes Stork periodically so a freshly-pushed feed recovers", async () => {
    const stork = fakeStork("notfound");
    const o = new ResilientOracle(
      "TESTUSD",
      stork.oracle as StorkOracle,
      new SyntheticOracle("TESTUSD"),
      3, // re-probe every 3rd read for the test
    );
    await o.getMark(); // read 1 → probe (NotFound), latch
    await o.getMark(); // read 2 → synthetic, no probe
    await o.getMark(); // read 3 → re-probe (3 % 3 == 0)
    expect(stork.calls()).toBe(2);
  });
});
