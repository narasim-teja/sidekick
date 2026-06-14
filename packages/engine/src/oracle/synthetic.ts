/**
 * Synthetic oracle — a deterministic, seeded mark for assets whose Stork feed is not pushed on
 * Arc testnet (ETH/SOL/HYPE/LINK; only BTCUSD is live — Spike B). It produces a smooth GBM-style
 * walk around a per-asset anchor so the per-block loop, funding, and decrement all run and demo on
 * every market, not just BTC.
 *
 * This is an honest stand-in: it echoes the CONFIGURED source it is substituting (`stork` or
 * `chainlink`) onto the mark rather than hardcoding `stork`, and the resilient wrapper in
 * `oracle/index.ts` tags the reading `synthetic-fallback` so a consumer can always tell a synthetic
 * mark from a real one. The real pull-update paths (`fetchStorkUpdate` / Data Streams) are the upgrade.
 *
 * Determinism: each call advances the walk by one step keyed off a seed + an internal block
 * counter, so a given engine run is reproducible (no `Math.random`), matching the sim's price
 * machinery. Output is WAD 18dp `price18`, the same unit the live Stork adapter normalizes to.
 *
 * @see packages/engine/src/sim/price.ts (the GBM generator this reuses)
 */

import type { MarkPrice, OracleAdapter, OracleSource } from "@sidekick/shared";
import { floatToWad } from "../fixed/units.ts";
import { mulberry32 } from "../sim/price.ts";

/** Plausible per-asset starting marks (USD) for the synthetic walk. Display anchors only. */
export const SYNTHETIC_ANCHORS: Record<string, number> = {
  BTCUSD: 70_000,
  ETHUSD: 3_500,
  SOLUSD: 180,
  HYPEUSD: 35,
  LINKUSD: 18,
};

/** A standard-normal shock via Box–Muller, driven by a [0,1) PRNG (matches sim/price.ts). */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A deterministic synthetic {@link OracleAdapter}. Each `getMark` advances a GBM step from the
 * previous mark, so the price walks smoothly block to block. Seeded from the asset symbol so
 * different markets diverge but each is reproducible.
 */
export class SyntheticOracle implements OracleAdapter {
  /**
   * The source this synthetic mark is STANDING IN FOR — echoed onto the mark so the fallback never
   * lies about which feed it is substituting (a Chainlink market's fallback reports `chainlink`, not
   * a false `stork`). Provenance (`synthetic-fallback`) is carried separately by the resilient
   * wrapper. Defaults to `"stork"` for back-compat with call sites that pass no source.
   */
  readonly source: OracleSource;
  private price: number;
  private readonly rand: () => number;
  private readonly volPerBlock: number;
  private readonly driftPerBlock: number;

  constructor(
    private readonly asset: string,
    opts: {
      start?: number;
      volPerBlock?: number;
      driftPerBlock?: number;
      seed?: number;
      source?: OracleSource;
    } = {},
  ) {
    this.source = opts.source ?? "stork";
    this.price = opts.start ?? SYNTHETIC_ANCHORS[asset] ?? 100;
    if (opts.start === undefined && SYNTHETIC_ANCHORS[asset] === undefined) {
      // An unknown asset anchors at 100 — visible, not silent, so a misconfigured market is caught.
      console.warn(
        `[synthetic] no anchor for "${asset}"; defaulting to 100 (add it to SYNTHETIC_ANCHORS)`,
      );
    }
    this.volPerBlock = opts.volPerBlock ?? 0.0006;
    this.driftPerBlock = opts.driftPerBlock ?? 0;
    // Seed off the asset name so each market has its own reproducible path.
    const seed = opts.seed ?? hashSeed(asset);
    this.rand = mulberry32(seed);
  }

  // Returns a resolved promise to satisfy the async OracleAdapter contract (live reads are async)
  // while the synthetic walk itself is synchronous.
  getMark(): Promise<MarkPrice> {
    const shock = this.volPerBlock * gaussian(this.rand);
    this.price = Math.max(this.price * (1 + this.driftPerBlock + shock), 0.01);
    return Promise.resolve({
      asset: this.asset,
      price18: floatToWad(this.price),
      timestampMs: 0, // synthetic — no real observation time; the wrapper stamps wall-clock if needed
      source: this.source,
    });
  }

  /** Current synthetic price as a float (for logs/anchoring), not used in the loop. */
  get currentPrice(): number {
    return this.price;
  }
}

/** A small stable hash of a string → 32-bit seed, so a symbol maps to a fixed PRNG seed. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
