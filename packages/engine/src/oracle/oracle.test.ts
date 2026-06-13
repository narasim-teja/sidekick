/**
 * Oracle-layer tests: synthetic determinism, `NotFound` detection, and the resilient
 * primary→fallback latch + re-probe. No live RPC — the Stork leg is faked so the test is hermetic
 * (a separate `live:oracle` script reads the real Arc feed).
 */

import { describe, expect, test } from "bun:test";
import type { MarkPrice, OracleAdapter } from "@sidekick/shared";
import { WAD } from "../fixed/units.ts";
import {
  CHAINLINK_STALE_MARK_SELECTOR,
  ChainlinkNotFoundError,
  isChainlinkNotFound,
} from "./chainlink.ts";
import { ResilientOracle } from "./index.ts";
import {
  isStorkNotFound,
  mapSignedPrice,
  parseStorkBody,
  StorkNotFoundError,
  type StorkOracle,
} from "./stork.ts";
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

describe("parseStorkBody (precision-safe ns timestamp)", () => {
  // A real 19-digit Stork ns timestamp, far past Number.MAX_SAFE_INTEGER (2^53 ≈ 9.0e15).
  const TS = "1781381678635405199";

  test("preserves the full 19-digit ns timestamp (plain JSON.parse would corrupt it)", () => {
    const raw = `{"data":{"BTCUSD":{"stork_signed_price":{"encoded_asset_id":"0xabc","price":"64220734239124991000000","timestamped_signature":{"signature":{"r":"0x1","s":"0x2","v":"0x1b"},"timestamp":${TS}},"publisher_merkle_root":"0xdef","calculation_alg":{"checksum":"9be7"}}}}}`;
    // Sanity: the naive path really does lose precision (this is the bug we are guarding against).
    expect(
      BigInt(JSON.parse(raw).data.BTCUSD.stork_signed_price.timestamped_signature.timestamp),
    ).not.toBe(BigInt(TS));
    // The fix keeps every digit by quoting the bare integer before parsing.
    const body = parseStorkBody(raw);
    const ts = body.data?.BTCUSD?.stork_signed_price.timestamped_signature.timestamp;
    expect(ts).toBe(TS);
    expect(BigInt(ts as string)).toBe(BigInt(TS));
  });

  test("does not disturb quoted string fields (hex ids / decimal price strings)", () => {
    const raw = `{"data":{"BTCUSD":{"stork_signed_price":{"encoded_asset_id":"0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de","price":"64220734239124991000000","timestamped_signature":{"signature":{"r":"0x1","s":"0x2","v":"0x1c"},"timestamp":${TS}},"publisher_merkle_root":"0x1f1e30","calculation_alg":{"checksum":"9be7e9f9"}}}}}`;
    const p = parseStorkBody(raw).data?.BTCUSD?.stork_signed_price;
    expect(p?.price).toBe("64220734239124991000000"); // long decimal string untouched
    expect(p?.encoded_asset_id).toBe(
      "0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de",
    );
  });

  test("mapSignedPrice carries the exact signed ns timestamp into the on-chain tuple", () => {
    const raw = `{"data":{"BTCUSD":{"stork_signed_price":{"encoded_asset_id":"0xabc","price":"64220734239124991000000","timestamped_signature":{"signature":{"r":"0x1","s":"0x2","v":"0x1c"},"timestamp":${TS}},"publisher_merkle_root":"0xdef","calculation_alg":{"checksum":"9be7"}}}}}`;
    const input = mapSignedPrice(parseStorkBody(raw).data!.BTCUSD!.stork_signed_price);
    expect(input.temporalNumericValue.timestampNs).toBe(BigInt(TS));
    expect(input.temporalNumericValue.quantizedValue).toBe(64220734239124991000000n);
    expect(input.valueComputeAlgHash).toBe("0x9be7"); // checksum gets the 0x prefix
    expect(input.v).toBe(28); // "0x1c" → 28
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

/** A fake Chainlink primary: returns a fixed mark, throws a StaleMark-selector error, or a typed error. */
function fakeChainlink(behavior: "live" | "stale" | "typed"): {
  oracle: OracleAdapter;
  calls: () => number;
} {
  let calls = 0;
  const oracle: OracleAdapter = {
    source: "chainlink",
    getMark(): Promise<MarkPrice> {
      calls += 1;
      if (behavior === "stale") {
        // The on-chain ChainlinkAdapter reverts StaleMark() — surfaced by viem as a selector string,
        // NOT as a non-positive price. This is the regression guard for the crash bug.
        return Promise.reject(
          new Error(`execution reverted, data: ${CHAINLINK_STALE_MARK_SELECTOR}`),
        );
      }
      if (behavior === "typed") {
        return Promise.reject(new ChainlinkNotFoundError("TESTUSD", "not pushed"));
      }
      return Promise.resolve({
        asset: "TESTUSD",
        price18: 1_675n * WAD,
        timestampMs: 1_700_000_000_000,
        source: "chainlink",
      });
    },
  };
  return { oracle, calls: () => calls };
}

describe("isChainlinkNotFound", () => {
  test("matches the StaleMark selector", () => {
    expect(isChainlinkNotFound(new Error(`reverted, data: ${CHAINLINK_STALE_MARK_SELECTOR}`))).toBe(
      true,
    );
  });
  test("matches a named StaleMark / FeedMismatch revert string", () => {
    expect(isChainlinkNotFound(new Error("execution reverted: StaleMark()"))).toBe(true);
    expect(isChainlinkNotFound(new Error("execution reverted: FeedMismatch()"))).toBe(true);
  });
  test("matches a ChainlinkNotFoundError", () => {
    expect(isChainlinkNotFound(new ChainlinkNotFoundError("ETHUSD", "no value"))).toBe(true);
  });
  test("does not match an unrelated RPC error or a Stork NotFound", () => {
    expect(isChainlinkNotFound(new Error("connection refused"))).toBe(false);
    expect(isChainlinkNotFound(new StorkNotFoundError("ETHUSD", "no value"))).toBe(false);
  });
});

describe("ResilientOracle (Chainlink primary)", () => {
  test("serves the live Chainlink mark and tags it chainlink-live", async () => {
    const cl = fakeChainlink("live");
    const o = new ResilientOracle(
      "TESTUSD",
      cl.oracle,
      new SyntheticOracle("TESTUSD", { source: "chainlink" }),
      150,
      isChainlinkNotFound,
    );
    const m = await o.getMark();
    expect(m.provenance).toBe("chainlink-live");
    expect(m.source).toBe("chainlink");
    expect(o.isSynthetic).toBe(false);
    expect(o.primarySource).toBe("chainlink");
  });

  test("latches to synthetic-fallback on a StaleMark revert (the crash-bug regression guard)", async () => {
    const cl = fakeChainlink("stale");
    const o = new ResilientOracle(
      "TESTUSD",
      cl.oracle,
      new SyntheticOracle("TESTUSD", { source: "chainlink" }),
      150,
      isChainlinkNotFound,
    );
    // Without the StaleMark-aware predicate this would THROW and crash the tick.
    const m = await o.getMark();
    expect(m.provenance).toBe("synthetic-fallback");
    // The synthetic fallback echoes the configured source — never a false "stork".
    expect(m.source).toBe("chainlink");
    expect(o.isSynthetic).toBe(true);
  });

  test("a non-recoverable error still throws (not every error is a feed miss)", async () => {
    const cl: OracleAdapter = {
      source: "chainlink",
      getMark: () => Promise.reject(new Error("connection refused")),
    };
    const o = new ResilientOracle(
      "TESTUSD",
      cl,
      new SyntheticOracle("TESTUSD", { source: "chainlink" }),
      150,
      isChainlinkNotFound,
    );
    await expect(o.getMark()).rejects.toThrow("connection refused");
  });
});

describe("SyntheticOracle source honesty", () => {
  test("echoes the configured source instead of hardcoding stork", async () => {
    const cl = await new SyntheticOracle("ETHUSD", { source: "chainlink" }).getMark();
    expect(cl.source).toBe("chainlink");
    const sk = await new SyntheticOracle("ETHUSD", { source: "stork" }).getMark();
    expect(sk.source).toBe("stork");
    const def = await new SyntheticOracle("ETHUSD").getMark();
    expect(def.source).toBe("stork"); // back-compat default
  });
});
