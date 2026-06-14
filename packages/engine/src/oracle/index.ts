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

  constructor(
    readonly asset: string,
    private readonly primary: OracleAdapter,
    private readonly fallback: SyntheticOracle,
    private readonly reprobeEvery = 150, // ~5 min at 2s blocks
    private readonly isRecoverable: RecoverablePredicate = isStorkNotFound,
  ) {}

  /** Read the mark, preferring the live primary feed and falling back to synthetic on a feed miss. */
  async getMark(): Promise<ResolvedMark> {
    this.reads += 1;
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

  /** Whether this market is currently being served by the synthetic fallback. */
  get isSynthetic(): boolean {
    return this.latchedSynthetic;
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
  const synthetic = new SyntheticOracle(market.asset, {
    source,
    ...(vol !== undefined ? { volPerBlock: vol } : {}),
    ...(drift !== undefined ? { driftPerBlock: drift } : {}),
  });

  return new ResilientOracle(market.asset, primary, synthetic, 150, isRecoverable);
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
