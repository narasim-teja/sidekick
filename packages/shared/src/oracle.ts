/**
 * Pluggable oracle adapter — the abstraction that lets SideKick read its mark price from
 * **either Stork or Chainlink** (co-equal options) behind one interface, chosen per-market
 * or swapped without touching the rest of the system.
 *
 * This is the type the engine (Layer A) and the CRE workflow (Layer C, Phase 6) both program
 * against. Concrete implementations land in the engine package; here we define the contract,
 * the discriminated config, and the asset-id helpers so every layer agrees on the shape.
 *
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §2 (Pattern 4) and §6 (CRE oracle delivery)
 */

import { type Hex, keccak256, toHex } from "viem";

/** Which underlying source backs a market's mark. */
export type OracleSource = "stork" | "chainlink";

/** A single normalized mark reading, source-agnostic. */
export interface MarkPrice {
  /** Asset symbol, e.g. "BTCUSD". */
  readonly asset: string;
  /**
   * Price scaled to 18 decimals (wei-style fixed point), independent of the source's
   * native precision. Adapters normalize into this so downstream math is uniform.
   */
  readonly price18: bigint;
  /** Observation time in milliseconds since the Unix epoch. */
  readonly timestampMs: number;
  /** The source that produced this reading. */
  readonly source: OracleSource;
}

/**
 * Per-market oracle configuration. Discriminated on `source` so each market names exactly
 * the source it uses and the identifier that source needs.
 */
export type OracleConfig =
  | {
      readonly source: "stork";
      /** Stork encoded asset id (bytes32) — see {@link storkAssetId}. */
      readonly assetId: Hex;
      /** Human-readable asset symbol, e.g. "BTCUSD". */
      readonly asset: string;
    }
  | {
      readonly source: "chainlink";
      /** Chainlink Data Feed / Data Stream id for the asset on Arc. */
      readonly feedId: Hex;
      /** Human-readable asset symbol, e.g. "BTCUSD". */
      readonly asset: string;
    };

/**
 * The pluggable oracle adapter. One method to read the current mark; implementations wrap
 * Stork (pull-based, signed update) or Chainlink (Data Feeds/Streams) and normalize to
 * {@link MarkPrice}. The engine holds one adapter per market and never branches on source.
 */
export interface OracleAdapter {
  /** Which source this adapter reads from. */
  readonly source: OracleSource;
  /** Read the latest mark for the configured asset, normalized to 18 decimals. */
  getMark(): Promise<MarkPrice>;
}

/**
 * Compute a Stork encoded asset id from a symbol.
 *
 * Stork derives the on-chain feed id as `keccak256(utf8(symbol))` (e.g. "BTCUSD").
 * Verify against the live Stork asset registry when running Spike B before relying on it
 * for an asset not yet confirmed.
 */
export function storkAssetId(symbol: string): Hex {
  return keccak256(toHex(symbol));
}

/**
 * The env-var suffix for a market symbol: uppercase + dash stripped (e.g. `"BTC-PERP" → "BTCPERP"`).
 *
 * This is the off-chain mirror of the deploy script's `_stripDash` (Deploy.s.sol) — the two layers
 * MUST agree byte-for-byte or the on-chain adapter and the engine's reader resolve different env keys
 * for the same market. Dashes are not valid env-var characters, so they are removed (NOT replaced with
 * `_`). Used to build `ORACLE_SOURCE_<suffix>` and `CHAINLINK_FEED_<suffix>`.
 */
export function oracleEnvKeySuffix(symbol: string): string {
  return symbol.toUpperCase().replace(/-/g, "");
}

/**
 * Resolve a Chainlink Data Streams feed id for a market from the environment.
 *
 * Unlike {@link storkAssetId}, a Chainlink feed id is NOT derivable from the symbol — it is a fixed
 * 32-byte Data Streams registry id (e.g. `0x0003…` for a v3 crypto stream), supplied per-market via
 * `CHAINLINK_FEED_<suffix>` (keyed by market symbol, dash-stripped — matching the deploy script's
 * `_feedEnvKey`). Throws if a market resolves to Chainlink but no feed id is configured, so a
 * misconfiguration fails loudly at boot rather than reading a zero feed id on-chain.
 */
export function chainlinkFeedId(
  symbol: string,
  env: Record<string, string | undefined> = process.env,
): Hex {
  const key = `CHAINLINK_FEED_${oracleEnvKeySuffix(symbol)}`;
  const raw = unquote(env[key]);
  if (!raw) {
    throw new Error(
      `${key} is required for the Chainlink-sourced market ${symbol} (a fixed 32-byte Data Streams feed id)`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${key}="${raw}" is not a 32-byte hex feed id (expected 0x + 64 hex chars)`);
  }
  return raw as Hex;
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
