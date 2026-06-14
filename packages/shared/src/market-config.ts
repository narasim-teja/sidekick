/**
 * The single oracle/market resolver — turns `(symbol, env)` into the env-resolved oracle source +
 * config, and resolves the active market set. This is the ONE source of truth the engine, the live
 * scripts, and the `/venue` descriptor all share, and it mirrors how `Deploy.s.sol` resolves the same
 * choices on-chain so the registered adapter and the engine's reader never disagree.
 *
 * Precedence (env-override + code default, per the locked design decision):
 *   per-market `ORACLE_SOURCE_<suffix>`  >  global `ORACLE_SOURCE`  >  the code default in MARKETS.
 *
 * Env keys use the dash-stripped suffix ({@link oracleEnvKeySuffix}) — `BTC-PERP → BTCPERP` — byte
 * identical to the deploy script's `_stripDash`, so `ORACLE_SOURCE_LINKPERP=chainlink` flips both the
 * on-chain adapter (StorkAdapter→ChainlinkAdapter) and the off-chain reader together.
 *
 * @see packages/contracts/script/Deploy.s.sol (the on-chain mirror: _sourceFor / _selectedMarkets)
 * @see packages/engine/src/oracle/index.ts (makeOracle consumes resolveOracle)
 */

import type { MarketSymbol } from "./markets.ts";
import { chainlinkOracle, getMarket, MARKET_SYMBOLS, storkOracle } from "./markets.ts";
import type { OracleConfig, OracleSource } from "./oracle.ts";
import { chainlinkFeedId, oracleEnvKeySuffix } from "./oracle.ts";

/** The oracle sources a market can be configured to use (must match the on-chain `Source` enum). */
const KNOWN_SOURCES: readonly OracleSource[] = ["stork", "chainlink"];

/**
 * Resolve a market's oracle source from env, falling back to its code default in `MARKETS`.
 * Per-market `ORACLE_SOURCE_<suffix>` wins over the global `ORACLE_SOURCE`, which wins over the
 * default. Throws (fail-fast at boot) if a configured value is not a known source.
 */
export function resolveOracleSource(
  symbol: MarketSymbol,
  env: Record<string, string | undefined> = process.env,
): OracleSource {
  const perMarketKey = `ORACLE_SOURCE_${oracleEnvKeySuffix(symbol)}`;
  const perMarket = unquote(env[perMarketKey]);
  const global = unquote(env.ORACLE_SOURCE);
  const codeDefault = getMarket(symbol).oracle.source;

  const raw = (perMarket || global || codeDefault).toLowerCase();
  if (!KNOWN_SOURCES.includes(raw as OracleSource)) {
    const key = perMarket ? perMarketKey : "ORACLE_SOURCE";
    throw new Error(
      `${key}="${raw}" is not a known oracle source (expected one of: ${KNOWN_SOURCES.join(", ")})`,
    );
  }
  return raw as OracleSource;
}

/**
 * Resolve the full {@link OracleConfig} for a market from env: the source plus the source-specific
 * identifier (Stork's derived `keccak256(symbol)` asset id, or Chainlink's env-supplied fixed feed
 * id). Throws if the market resolves to Chainlink but `CHAINLINK_FEED_<suffix>` is unset.
 */
export function resolveOracle(
  symbol: MarketSymbol,
  env: Record<string, string | undefined> = process.env,
): OracleConfig {
  const asset = getMarket(symbol).asset;
  const source = resolveOracleSource(symbol, env);
  return source === "chainlink"
    ? chainlinkOracle(asset, chainlinkFeedId(symbol, env))
    : storkOracle(asset);
}

/**
 * Resolve the active market set from `MARKETS` (a comma list, or `all`/unset → all five). Unknown
 * symbols are silently dropped (matching the deploy script and the prior engine resolver); an empty
 * result falls back to `["BTC-PERP"]` so the engine always has at least one market to loop.
 *
 * This is the same `MARKETS` var the deploy script reads (`vm.envOr("MARKETS", …)`) — chain and
 * engine agree on which markets exist. (Replaces the old `ENGINE_MARKETS`.)
 */
export function resolveMarketSet(
  env: Record<string, string | undefined> = process.env,
): MarketSymbol[] {
  const raw = unquote(env.MARKETS) ?? "";
  if (raw === "" || raw.toLowerCase() === "all") return [...MARKET_SYMBOLS];

  const known = new Set<string>(MARKET_SYMBOLS);
  const selected = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is MarketSymbol => known.has(s));

  return selected.length > 0 ? selected : ["BTC-PERP"];
}

/** Trim and strip one surrounding pair of quotes from an env value (the engine .env loader keeps them). */
function unquote(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}
