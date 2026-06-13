/**
 * Chainlink Data Streams oracle adapter (live read path) — reads the mark through the DEPLOYED
 * on-chain `ChainlinkAdapter` (`IOracleAdapter.getMark()`), exactly as {@link StorkOracle} reads the
 * `StorkAdapter`. The engine stays source-agnostic: it programs against the shared `OracleAdapter`
 * type and never branches on Stork vs Chainlink — `makeOracle` picks which class to construct.
 *
 * WHY READ THE ADAPTER, NOT AN OFF-CHAIN REPORT: Data Streams is a pull oracle (fetch a signed
 * `fullReport` over REST → verify on-chain → store). The on-chain `ChainlinkAdapter` does the verify
 * + store; `getMark()` is then a trivial `view` returning the stored 18-dp price. Reading that stored
 * value (rather than decoding a fetched report off-chain) keeps off-chain == on-chain parity and reuses
 * the same `ORACLE_ADAPTER_ABI` with zero new wiring.
 *
 * STALENESS: a never-pushed or stale `ChainlinkAdapter.getMark()` REVERTS `StaleMark()` (it does NOT
 * return a non-positive price). The engine's resilient wrapper treats that revert exactly as it treats
 * Stork's `NotFound` — latch to the synthetic fallback, re-probe later — via {@link isChainlinkNotFound}.
 * Because Arc Data Streams availability is unconfirmed, every Chainlink market is in the stale state at
 * demo time, so this is the guaranteed path, not an edge case.
 *
 * @see packages/contracts/src/oracle/ChainlinkAdapter.sol (the contract this reads; emits StaleMark)
 * @see packages/engine/src/oracle/stork.ts (the structural twin this mirrors)
 */

import type { MarkPrice, OracleAdapter } from "@sidekick/shared";
import { chainlinkStreamsHost } from "@sidekick/shared";
import type { Address, PublicClient } from "viem";
import { ORACLE_ADAPTER_ABI } from "../chain/abis.ts";

/** `ChainlinkAdapter.StaleMark()` selector — the revert for a never-pushed/stale stored mark. */
export const CHAINLINK_STALE_MARK_SELECTOR = "0xabacdeb5";
/** `ChainlinkAdapter.FeedMismatch()` selector — a misconfigured feed id (also recoverable→synthetic). */
export const CHAINLINK_FEED_MISMATCH_SELECTOR = "0x88da9ada";

/** A reading from the on-chain ChainlinkAdapter: `getMark()` returns `(price18, timestampMs)`. */
interface OnChainMark {
  price18: bigint;
  timestampMs: bigint;
}

/**
 * An {@link OracleAdapter} that reads a deployed `ChainlinkAdapter` contract on-chain. `getMark`
 * calls the contract's `getMark()` view and returns the normalized 18-decimal price. Structurally
 * identical to {@link StorkOracle} so the engine treats both uniformly.
 */
export class ChainlinkStreamsOracle implements OracleAdapter {
  readonly source = "chainlink" as const;

  constructor(
    private readonly client: PublicClient,
    private readonly adapterAddress: Address,
    private readonly asset: string,
  ) {}

  async getMark(): Promise<MarkPrice> {
    const m = (await this.client.readContract({
      address: this.adapterAddress,
      abi: ORACLE_ADAPTER_ABI,
      functionName: "getMark",
    })) as OnChainMark;
    if (m.price18 <= 0n) {
      throw new ChainlinkNotFoundError(this.asset, "adapter returned a non-positive price");
    }
    return {
      asset: this.asset,
      price18: m.price18,
      timestampMs: Number(m.timestampMs),
      source: "chainlink",
    };
  }
}

/** Thrown when a Chainlink feed has no fresh value on-chain (the read reverts `StaleMark`/`FeedMismatch`). */
export class ChainlinkNotFoundError extends Error {
  constructor(
    readonly asset: string,
    detail: string,
  ) {
    super(`Chainlink feed for ${asset} not available on-chain: ${detail}`);
    this.name = "ChainlinkNotFoundError";
  }
}

/**
 * True if a thrown error is a recoverable Chainlink feed miss — used to trigger the synthetic
 * fallback (the analogue of {@link isStorkNotFound}). Matches a `ChainlinkNotFoundError`, the
 * `StaleMark` / `FeedMismatch` selectors, or their named-revert string forms. Without this, a
 * never-pushed Chainlink market re-throws and crashes the per-block tick.
 */
export function isChainlinkNotFound(err: unknown): boolean {
  if (err instanceof ChainlinkNotFoundError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes(CHAINLINK_STALE_MARK_SELECTOR) ||
    msg.includes(CHAINLINK_FEED_MISMATCH_SELECTOR) ||
    /StaleMark/i.test(msg) ||
    /FeedMismatch/i.test(msg)
  );
}

// ── REST pull path (Data Streams) — STUB, not yet wired into the loop ─────────────────
//
// The analogue of Stork's `refreshStorkMarks`: fetch a fresh signed report over the Data Streams REST
// API and push it on-chain so `ChainlinkAdapter.getMark` returns a live value. Documented + signature-
// stubbed here, NOT fully implemented, because (a) the Arc Data Streams Verifier proxy address is
// unconfirmed and (b) the verify-fee flow (FeeManager.getFeeAndReward / LINK approve) is out of scope
// for the read path. Like `refreshStorkMarks`, this has no per-block caller today — the demo path is
// the adapter's relay mode (`pushMarkUnverified`). The credential probe in
// `scripts/chainlink-probe.ts` already proves the REST auth + report shape this would build on.
//
// REST shape (verified live via chainlink-probe.ts):
//   GET https://${chainlinkStreamsHost(env)}/api/v1/reports/latest?feedID=<id>
//   headers: Authorization: <CHAINLINK_API_KEY>,
//            X-Authorization-Timestamp: <ms>,
//            X-Authorization-Signature-SHA256: HMAC-SHA256(CHAINLINK_API_SECRET,
//                "<METHOD> <path> <sha256hex(body)> <CHAINLINK_API_KEY> <ts>")
//   → { report: { feedID, validFromTimestamp, observationsTimestamp, fullReport } }
//   The opaque `fullReport` blob is passed straight to ChainlinkAdapter.pushReport (do NOT decode
//   off-chain) — the on-chain verify decodes + stores it.
//
// @see https://docs.chain.link/data-streams/reference/data-streams-api/authentication
export interface ChainlinkReportFetch {
  feedId: `0x${string}`;
  fullReport: `0x${string}`;
  observationsTimestampMs: number;
}

/** STUB — fetch the latest signed Data Streams report for a feed id. Not yet wired (see note above). */
export function fetchChainlinkReport(
  _feedId: `0x${string}`,
  _env: Record<string, string | undefined> = process.env,
): Promise<ChainlinkReportFetch> {
  void chainlinkStreamsHost; // referenced so the import is live for the real implementation
  return Promise.reject(
    new Error(
      "fetchChainlinkReport is not yet wired — the demo path is the adapter's relay mode " +
        "(pushMarkUnverified). See scripts/chainlink-probe.ts for the verified REST shape.",
    ),
  );
}
