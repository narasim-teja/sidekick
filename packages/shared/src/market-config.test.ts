/**
 * Resolver tests — the env-override precedence, fail-fast validation, and market-set selection that
 * the engine + deploy script both depend on. Pure (no RPC): everything is a function of an env map.
 */

import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { resolveMarketSet, resolveOracle, resolveOracleSource } from "./market-config.ts";
import { MARKET_SYMBOLS } from "./markets.ts";
import { chainlinkFeedId, oracleEnvKeySuffix } from "./oracle.ts";

const FEED = `0x${"a".repeat(64)}` as Hex;

describe("oracleEnvKeySuffix (mirror of Deploy._stripDash)", () => {
  test("uppercases and strips dashes", () => {
    expect(oracleEnvKeySuffix("BTC-PERP")).toBe("BTCPERP");
    expect(oracleEnvKeySuffix("link-perp")).toBe("LINKPERP");
  });

  // Drift guard: these MUST equal what Deploy.s.sol's `_stripDash` produces, or the on-chain adapter
  // and the off-chain reader resolve different env keys for the same market. If a market symbol is
  // renamed, update Deploy.s.sol AND this map together.
  test("matches the on-chain _stripDash for every market symbol", () => {
    const onChain: Record<string, string> = {
      "BTC-PERP": "BTCPERP",
      "ETH-PERP": "ETHPERP",
      "SOL-PERP": "SOLPERP",
      "HYPE-PERP": "HYPEPERP",
      "LINK-PERP": "LINKPERP",
    };
    for (const [symbol, suffix] of Object.entries(onChain)) {
      expect(oracleEnvKeySuffix(symbol)).toBe(suffix);
    }
  });
});

describe("resolveOracleSource precedence", () => {
  test("defaults to the code default (stork) with no env", () => {
    expect(resolveOracleSource("BTC-PERP", {})).toBe("stork");
  });
  test("global ORACLE_SOURCE overrides the code default", () => {
    expect(resolveOracleSource("BTC-PERP", { ORACLE_SOURCE: "chainlink" })).toBe("chainlink");
  });
  test("per-market ORACLE_SOURCE_<SYM> overrides the global", () => {
    const env = { ORACLE_SOURCE: "chainlink", ORACLE_SOURCE_BTCPERP: "stork" };
    expect(resolveOracleSource("BTC-PERP", env)).toBe("stork");
  });
  test("is case-insensitive and quote-tolerant", () => {
    expect(resolveOracleSource("BTC-PERP", { ORACLE_SOURCE: '"CHAINLINK"' })).toBe("chainlink");
  });
  test("throws fail-fast on an unknown source", () => {
    expect(() => resolveOracleSource("BTC-PERP", { ORACLE_SOURCE: "pyth" })).toThrow(
      /not a known oracle source/,
    );
  });
});

describe("resolveOracle", () => {
  test("builds the Stork config (derived asset id) by default", () => {
    const cfg = resolveOracle("BTC-PERP", {});
    expect(cfg.source).toBe("stork");
    if (cfg.source === "stork") expect(cfg.assetId).toMatch(/^0x[0-9a-f]{64}$/i);
  });
  test("builds the Chainlink config from CHAINLINK_FEED_<SYM>", () => {
    const env = { ORACLE_SOURCE_LINKPERP: "chainlink", CHAINLINK_FEED_LINKPERP: FEED };
    const cfg = resolveOracle("LINK-PERP", env);
    expect(cfg.source).toBe("chainlink");
    if (cfg.source === "chainlink") expect(cfg.feedId).toBe(FEED);
  });
  test("throws if Chainlink is chosen but the feed id is missing", () => {
    const env = { ORACLE_SOURCE_LINKPERP: "chainlink" };
    expect(() => resolveOracle("LINK-PERP", env)).toThrow(/CHAINLINK_FEED_LINKPERP is required/);
  });
});

describe("chainlinkFeedId", () => {
  test("rejects a non-32-byte value", () => {
    expect(() => chainlinkFeedId("LINK-PERP", { CHAINLINK_FEED_LINKPERP: "0x1234" })).toThrow(
      /not a 32-byte hex feed id/,
    );
  });
});

describe("resolveMarketSet", () => {
  test("unset → all markets", () => {
    expect(resolveMarketSet({})).toEqual([...MARKET_SYMBOLS]);
  });
  test("'all' → all markets", () => {
    expect(resolveMarketSet({ MARKETS: "all" })).toEqual([...MARKET_SYMBOLS]);
  });
  test("a comma list selects a subset and trims whitespace", () => {
    expect(resolveMarketSet({ MARKETS: "BTC-PERP, LINK-PERP" })).toEqual(["BTC-PERP", "LINK-PERP"]);
  });
  test("unknown symbols are silently dropped", () => {
    expect(resolveMarketSet({ MARKETS: "BTC-PERP,DOGE-PERP" })).toEqual(["BTC-PERP"]);
  });
  test("an all-unknown list falls back to BTC-PERP", () => {
    expect(resolveMarketSet({ MARKETS: "DOGE-PERP" })).toEqual(["BTC-PERP"]);
  });
});
