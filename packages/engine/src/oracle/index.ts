/**
 * The pluggable oracle layer for the live engine. Each market gets ONE adapter the loop reads the
 * mark from; the engine never branches on source. Per the Phase-3 oracle plan:
 *
 *   - Resolve the market's source from config/env ({@link resolveOracle}) — Stork or Chainlink.
 *   - Read the mark through the deployed on-chain adapter (`StorkAdapter` or `ChainlinkAdapter`),
 *     both behind the same `getMark()` view, via {@link StorkOracle} / {@link ChainlinkStreamsOracle}.
 *   - If that feed is not fresh on-chain (Stork `NotFound`, or Chainlink `StaleMark` — true for
 *     every Chainlink market until a verified push lands, and for unpushed Stork assets), fall back
 *     to a deterministic {@link SyntheticOracle} so every market still demos. The synthetic mark
 *     echoes the CONFIGURED source, so a fallback is honestly labeled, never a false `stork`.
 *
 * Swapping a market between Stork and Chainlink is a config/env change (`ORACLE_SOURCE_<MARKET>`) —
 * no change to the engine loop.
 */

import type { MarketConfig, MarkPrice, OracleAdapter, OracleSource } from "@sidekick/shared";
import { resolveOracle } from "@sidekick/shared";
import type { Address, PublicClient } from "viem";
import { ORACLE_ADAPTER_ABI } from "../chain/abis.ts";
import { wadToFloat } from "../fixed/units.ts";
import { ChainlinkStreamsOracle, isChainlinkNotFound } from "./chainlink.ts";
import { isStorkNotFound, StorkOracle } from "./stork.ts";
import { SyntheticOracle } from "./synthetic.ts";

export {
  ChainlinkNotFoundError,
  ChainlinkStreamsOracle,
  fetchChainlinkReport,
  isChainlinkNotFound,
} from "./chainlink.ts";
export { fetchStorkUpdate, isStorkNotFound, StorkNotFoundError, StorkOracle } from "./stork.ts";
export { SYNTHETIC_ANCHORS, SyntheticOracle } from "./synthetic.ts";

/**
 * Which path actually served a mark this read — surfaced for the dashboard + honest logging.
 * `*-live` = the real on-chain feed for that source; `synthetic-fallback` = the deterministic
 * stand-in (regardless of which source it is substituting).
 */
export type MarkProvenance = "stork-live" | "chainlink-live" | "synthetic-fallback";

/** A mark plus how it was sourced (so the UI can label a synthetic mark, not pass it off as real). */
export interface ResolvedMark extends MarkPrice {
  provenance: MarkProvenance;
}

/** A predicate that decides whether a primary-read error is a recoverable feed miss (→ fall back). */
export type RecoverablePredicate = (err: unknown) => boolean;

/**
 * A resilient oracle: try the live primary read first (Stork or Chainlink), fall back to a
 * deterministic synthetic mark if (and only if) the feed is not fresh on-chain. Once a market is
 * found to be missing, it "latches" to the synthetic path so we don't pay a reverting RPC round-trip
 * every block — but a periodic re-probe (every `reprobeEvery` reads) lets a freshly-pushed feed
 * recover automatically. The recovery predicate is source-specific (Stork `NotFound` vs Chainlink
 * `StaleMark`); it defaults to {@link isStorkNotFound} so existing 3/4-arg call sites are unchanged.
 */
export class ResilientOracle {
  private latchedSynthetic = false;
  private reads = 0;
  private liveAnchorTried = false;

  constructor(
    readonly asset: string,
    private readonly primary: OracleAdapter,
    private readonly fallback: SyntheticOracle,
    private readonly reprobeEvery = 150, // ~5 min at 2s blocks
    private readonly isRecoverable: RecoverablePredicate = isStorkNotFound,
    /**
     * Force the synthetic walk and never read the live primary feed (`MARK_MODE=synthetic`). This is
     * a DEMO knob, not the production path: a real feed (BTC/ETH/LINK/gold) barely moves over a few
     * minutes, so on a live mark no agent's equity ever crosses the 1% maintenance line and the
     * headline x402 margin-call flow never fires. Forcing the drifting synthetic mark
     * (`SYNTH_DRIFT_PER_BLOCK`) erodes the levered longs deterministically so calls — and the
     * nanopayments answering them — actually happen on camera. The mark is still tagged
     * `synthetic-fallback`, so it is never passed off as a real feed.
     */
    private readonly forceSynthetic = false,
    /**
     * When forcing synthetic, re-anchor the walk to the REAL current price read once from the primary
     * feed on the first read (`MARK_MODE=synthetic` + `SYNTH_LIVE_ANCHOR=1`). This makes the DISPLAYED
     * number the real current price (not a stale `SYNTHETIC_ANCHORS` constant that can drift to an
     * absurd floor like ETH $1,005), while the bounded walk still moves enough to keep margin calls —
     * and the nanopayments answering them — firing. The mark stays honestly tagged `synthetic-fallback`
     * (the number is real-current, but WE are walking it, so it is not the live feed). A failed live
     * probe falls back silently to the static anchor.
     */
    private readonly liveAnchor = false,
  ) {}

  /** Read the mark, preferring the live primary feed and falling back to synthetic on a feed miss. */
  async getMark(): Promise<ResolvedMark> {
    this.reads += 1;

    // Forced synthetic (demo): serve the drift walk directly, skipping the live probe entirely.
    if (this.forceSynthetic) {
      // One-time: re-anchor the walk to the real current price so the displayed number is believable.
      if (this.liveAnchor && !this.liveAnchorTried) {
        this.liveAnchorTried = true;
        try {
          const seed = await this.primary.getMark();
          this.fallback.reanchor(wadToFloat(seed.price18));
        } catch {
          // Live probe failed (feed not fresh / RPC) — keep the static anchor. Non-fatal.
        }
      }
      const m = await this.fallback.getMark();
      return { ...m, provenance: "synthetic-fallback" };
    }

    const shouldReprobe = this.latchedSynthetic && this.reads % this.reprobeEvery === 0;

    if (!this.latchedSynthetic || shouldReprobe) {
      try {
        const m = await this.primary.getMark();
        if (this.latchedSynthetic) this.latchedSynthetic = false; // a re-probe recovered the feed
        return { ...m, provenance: this.liveProvenance() };
      } catch (err) {
        if (!this.isRecoverable(err)) throw err; // a real RPC error is not a missing feed — surface it
        this.latchedSynthetic = true;
      }
    }
    const m = await this.fallback.getMark();
    return { ...m, provenance: "synthetic-fallback" };
  }

  /** The provenance tag for a successful live read, derived from the primary's source. */
  private liveProvenance(): MarkProvenance {
    return this.primary.source === "chainlink" ? "chainlink-live" : "stork-live";
  }

  /** The configured source this market reads from (for `asOracleAdapter` + descriptor labeling). */
  get primarySource(): OracleSource {
    return this.primary.source;
  }

  /** Whether the synthetic walk is forced (demo `MARK_MODE=synthetic`), bypassing the live feed. */
  get isForcedSynthetic(): boolean {
    return this.forceSynthetic;
  }

  /** Whether this market is currently being served by the synthetic fallback. */
  get isSynthetic(): boolean {
    return this.forceSynthetic || this.latchedSynthetic;
  }

  /**
   * Clear the synthetic latch so the NEXT {@link getMark} re-probes the primary feed immediately
   * (instead of waiting for the periodic ~150-read re-probe). The loop calls this right after it
   * successfully pushes a fresh Stork mark on-chain — the engine knows the feed is now fresh, so it
   * shouldn't keep serving synthetic until the slow re-probe window.
   */
  clearFallback(): void {
    this.latchedSynthetic = false;
  }
}

/**
 * Build the oracle for a market from its config + the deployed adapter address. Resolves the source
 * from env ({@link resolveOracle}) and constructs the matching primary reader + recovery predicate,
 * wrapped in a {@link ResilientOracle} with a source-honest synthetic fallback.
 */
export function makeOracle(
  client: PublicClient,
  market: MarketConfig,
  adapterAddress: Address,
  env: Record<string, string | undefined> = process.env,
): ResilientOracle {
  const source = resolveOracle(market.symbol, env).source;

  const primary: OracleAdapter =
    source === "chainlink"
      ? new ChainlinkStreamsOracle(client, adapterAddress, market.asset)
      : new StorkOracle(client, adapterAddress, market.asset);
  const isRecoverable = source === "chainlink" ? isChainlinkNotFound : isStorkNotFound;

  // The synthetic fallback's walk is env-tunable so a demo can dial in a visible mark move
  // (a downward drift makes a high-leverage long decrement legibly on camera, for example). It
  // echoes the configured source so its mark is honestly labeled, not a false "stork".
  const vol = env.SYNTH_VOL_PER_BLOCK ? Number(env.SYNTH_VOL_PER_BLOCK) : undefined;
  const drift = env.SYNTH_DRIFT_PER_BLOCK ? Number(env.SYNTH_DRIFT_PER_BLOCK) : undefined;
  // Band fractions bound the cumulative walk to [min,max]·anchor — tighten them (e.g. 0.96–1.04) so a
  // live-anchored mark stays within a few % of the real price instead of drifting to a far floor.
  const minFraction = env.SYNTH_MIN_FRACTION ? Number(env.SYNTH_MIN_FRACTION) : undefined;
  const maxFraction = env.SYNTH_MAX_FRACTION ? Number(env.SYNTH_MAX_FRACTION) : undefined;
  const synthetic = new SyntheticOracle(market.asset, {
    source,
    ...(vol !== undefined ? { volPerBlock: vol } : {}),
    ...(drift !== undefined ? { driftPerBlock: drift } : {}),
    ...(minFraction !== undefined ? { minFraction } : {}),
    ...(maxFraction !== undefined ? { maxFraction } : {}),
  });

  const forceSynthetic = resolveForceSynthetic(market.symbol, env);
  // Live-anchor (default ON whenever synthetic is forced): re-anchor the walk to the real current
  // price at boot so the displayed number is believable. Disable with SYNTH_LIVE_ANCHOR=0.
  const liveAnchor = forceSynthetic && env.SYNTH_LIVE_ANCHOR !== "0" && env.SYNTH_LIVE_ANCHOR !== "false";
  return new ResilientOracle(
    market.asset,
    primary,
    synthetic,
    150,
    isRecoverable,
    forceSynthetic,
    liveAnchor,
  );
}

/**
 * Whether to FORCE the synthetic mark for a market (demo knob, off by default). A live feed barely
 * moves over a few minutes, so the headline x402 margin-call flow never fires on it; forcing the
 * drifting synthetic mark (`SYNTH_DRIFT_PER_BLOCK`) makes the levered longs decrement — and pay —
 * deterministically on camera. Resolution mirrors `ORACLE_SOURCE`:
 *   - `MARK_MODE=synthetic` (or the `SYNTH_FORCE=1` alias) forces it for ALL markets;
 *   - `MARK_MODE_<MARKET>=synthetic|live` overrides per market (e.g. `MARK_MODE_ETHPERP=synthetic`).
 * Any value other than `synthetic` (e.g. `live`) means use the real feed with synthetic only as the
 * failure fallback — the normal behaviour.
 */
export function resolveForceSynthetic(
  symbol: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const perMarketKey = `MARK_MODE_${symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase()}`;
  const perMarket = env[perMarketKey];
  if (perMarket !== undefined) return perMarket.toLowerCase() === "synthetic";
  if (env.MARK_MODE !== undefined) return env.MARK_MODE.toLowerCase() === "synthetic";
  const alias = env.SYNTH_FORCE?.toLowerCase();
  return alias === "1" || alias === "true";
}

/**
 * Assert that the on-chain adapter actually reports the source we resolved for it — so a `chainlink`
 * resolution can never be silently read off a `StorkAdapter` (or vice-versa) and mislabeled as
 * `chainlink-live`. `deployments.ts` records only adapter ADDRESSES (no per-market source field), so
 * this on-chain `source()` cross-check is the only guarantee the provenance tag is not a lie. Reads
 * the free `pure` `source()` once at boot; throws loudly on mismatch.
 */
export async function assertAdapterSource(
  client: PublicClient,
  adapterAddress: Address,
  expected: OracleSource,
): Promise<void> {
  const onChain = (await client.readContract({
    address: adapterAddress,
    abi: ORACLE_ADAPTER_ABI,
    functionName: "source",
  })) as string;
  if (onChain !== expected) {
    throw new Error(
      `oracle source mismatch at ${adapterAddress}: configured "${expected}" but the deployed ` +
        `adapter reports "${onChain}". Check ORACLE_SOURCE_<MARKET> vs what was registered on-chain.`,
    );
  }
}

/** A type guard so callers can treat a ResilientOracle as the shared OracleAdapter shape. */
export function asOracleAdapter(o: ResilientOracle): OracleAdapter {
  return { source: o.primarySource, getMark: () => o.getMark() };
}
