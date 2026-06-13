/**
 * The pluggable oracle layer for the live engine. Each market gets ONE adapter the loop reads the
 * mark from; the engine never branches on source. Per the Phase-3 oracle plan:
 *
 *   - Read the mark through the deployed on-chain `StorkAdapter` (the real Stork leg).
 *   - If that feed is not pushed on Arc testnet (reverts `NotFound` — true for ETH/SOL/HYPE/LINK),
 *     fall back to a deterministic {@link SyntheticOracle} so every market still demos.
 *   - The real Stork REST pull-update (`fetchStorkUpdate`) is the documented upgrade that makes the
 *     live read path work for the currently-unpushed assets.
 *
 * Chainlink slots in here behind the same {@link OracleAdapter} type once its Arc feeds are
 * confirmed (the CRE / Connect-the-World leg, Phase 6) — no change to the engine.
 */

import type { MarketConfig, MarkPrice, OracleAdapter } from "@sidekick/shared";
import type { Address, PublicClient } from "viem";
import { isStorkNotFound, StorkOracle } from "./stork.ts";
import { SyntheticOracle } from "./synthetic.ts";

export { fetchStorkUpdate, isStorkNotFound, StorkNotFoundError, StorkOracle } from "./stork.ts";
export { SYNTHETIC_ANCHORS, SyntheticOracle } from "./synthetic.ts";

/** Which path actually served a mark this read — surfaced for the dashboard + honest logging. */
export type MarkProvenance = "stork-live" | "synthetic-fallback";

/** A mark plus how it was sourced (so the UI can label a synthetic mark, not pass it off as real). */
export interface ResolvedMark extends MarkPrice {
  provenance: MarkProvenance;
}

/**
 * A resilient oracle: try the live Stork read first, fall back to a deterministic synthetic mark
 * if (and only if) the feed is not pushed on-chain. Once a market is found to be unpushed, it
 * "latches" to the synthetic path so we don't pay a reverting RPC round-trip every block — but a
 * periodic re-probe (every `reprobeEvery` reads) lets a freshly-pushed feed recover automatically.
 */
export class ResilientOracle {
  private latchedSynthetic = false;
  private reads = 0;

  constructor(
    readonly asset: string,
    private readonly primary: StorkOracle,
    private readonly fallback: SyntheticOracle,
    private readonly reprobeEvery = 150, // ~5 min at 2s blocks
  ) {}

  /** Read the mark, preferring the live Stork feed and falling back to synthetic on `NotFound`. */
  async getMark(): Promise<ResolvedMark> {
    this.reads += 1;
    const shouldReprobe = this.latchedSynthetic && this.reads % this.reprobeEvery === 0;

    if (!this.latchedSynthetic || shouldReprobe) {
      try {
        const m = await this.primary.getMark();
        if (this.latchedSynthetic) this.latchedSynthetic = false; // a re-probe recovered the feed
        return { ...m, provenance: "stork-live" };
      } catch (err) {
        if (!isStorkNotFound(err)) throw err; // a real RPC error is not a missing feed — surface it
        this.latchedSynthetic = true;
      }
    }
    const m = await this.fallback.getMark();
    return { ...m, provenance: "synthetic-fallback" };
  }

  /** Whether this market is currently being served by the synthetic fallback. */
  get isSynthetic(): boolean {
    return this.latchedSynthetic;
  }
}

/**
 * Build the oracle for a market from its config + the deployed adapter address. Returns a
 * {@link ResilientOracle} (live Stork + synthetic fallback). Chainlink markets would construct a
 * `ChainlinkOracle` here behind the same interface (added when Arc feeds are confirmed).
 */
export function makeOracle(
  client: PublicClient,
  market: MarketConfig,
  adapterAddress: Address,
  env: Record<string, string | undefined> = process.env,
): ResilientOracle {
  const stork = new StorkOracle(client, adapterAddress, market.asset);
  // The synthetic fallback's walk is env-tunable so a demo can dial in a visible mark move
  // (a downward drift makes a high-leverage long decrement legibly on camera, for example).
  const vol = env.SYNTH_VOL_PER_BLOCK ? Number(env.SYNTH_VOL_PER_BLOCK) : undefined;
  const drift = env.SYNTH_DRIFT_PER_BLOCK ? Number(env.SYNTH_DRIFT_PER_BLOCK) : undefined;
  const synthetic = new SyntheticOracle(market.asset, {
    ...(vol !== undefined ? { volPerBlock: vol } : {}),
    ...(drift !== undefined ? { driftPerBlock: drift } : {}),
  });
  return new ResilientOracle(market.asset, stork, synthetic);
}

/** A type guard so callers can treat a ResilientOracle as the shared OracleAdapter shape. */
export function asOracleAdapter(o: ResilientOracle): OracleAdapter {
  return { source: "stork", getMark: () => o.getMark() };
}
