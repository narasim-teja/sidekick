/**
 * Stork oracle adapter (live read path) — reads the mark through the DEPLOYED on-chain
 * `StorkAdapter` (`IOracleAdapter.getMark()`), which normalizes Stork's feed to 18 decimals. This
 * keeps the engine source-agnostic: it programs against the shared {@link OracleAdapter} type and
 * never branches on Stork vs Chainlink.
 *
 * On Arc testnet only **BTCUSD** is currently pushed (Spike B / verified live: ~$70,627). The
 * other four assets have valid feed ids but the read reverts Stork `NotFound` until a fresh signed
 * update is injected via the REST pull path ({@link fetchStorkUpdate} + on-chain
 * `updateTemporalNumericValuesV1`). The engine wraps this adapter with a synthetic fallback
 * (`oracle/index.ts`) so all five markets demo; this module is the real Stork leg.
 *
 * @see packages/contracts/src/oracle/StorkAdapter.sol (the contract this reads)
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §9 (Stork facts) / §10 (testnet coverage)
 */

import type { MarkPrice, OracleAdapter } from "@sidekick/shared";
import { STORK } from "@sidekick/shared";
import type { Address, PublicClient } from "viem";
import { ORACLE_ADAPTER_ABI } from "../chain/abis.ts";

/** Stork's `NotFound` selector — the revert for an asset id with no pushed value on this chain. */
export const STORK_NOT_FOUND_SELECTOR = "0xc5723b51";

/** A reading from the on-chain StorkAdapter: `getMark()` returns `(price18, timestampMs)`. */
interface OnChainMark {
  price18: bigint;
  timestampMs: bigint;
}

/**
 * An {@link OracleAdapter} that reads a deployed `StorkAdapter` contract on-chain. `getMark` calls
 * the contract's `getMark()` view and returns the normalized 18-decimal price.
 */
export class StorkOracle implements OracleAdapter {
  readonly source = "stork" as const;

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
      throw new StorkNotFoundError(this.asset, "adapter returned a non-positive price");
    }
    return {
      asset: this.asset,
      price18: m.price18,
      timestampMs: Number(m.timestampMs),
      source: "stork",
    };
  }
}

/** Thrown when a Stork feed has no value on this chain (the read reverts `NotFound` or returns 0). */
export class StorkNotFoundError extends Error {
  constructor(
    readonly asset: string,
    detail: string,
  ) {
    super(`Stork feed for ${asset} not available on-chain: ${detail}`);
    this.name = "StorkNotFoundError";
  }
}

/** True if a thrown error is a Stork `NotFound` (feed not pushed) — used to trigger the fallback. */
export function isStorkNotFound(err: unknown): boolean {
  if (err instanceof StorkNotFoundError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(STORK_NOT_FOUND_SELECTOR) || /NotFound/i.test(msg);
}

// ── REST pull path (the documented upgrade for the unpushed assets) ──────────────────

/**
 * Fetch a signed Stork price update over REST (Basic auth, key in `STORK_API_KEY`). The returned
 * payload is what `Stork.updateTemporalNumericValuesV1` expects on-chain — injecting it pushes the
 * feed so the read path above stops reverting. Wiring the on-chain injection is the production
 * upgrade for ETH/SOL/HYPE/LINK; the engine falls back to a synthetic mark until then.
 *
 * Returns the raw REST response (the encoding is Stork-specific; we surface it for the injector to
 * use without taking a hard dependency on the exact shape, which the Stork SDK owns).
 */
export async function fetchStorkUpdate(
  assets: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<unknown> {
  const apiKey = env.STORK_API_KEY;
  const base = env.STORK_REST_URL || STORK.restUrl;
  if (!apiKey) throw new Error("STORK_API_KEY is required for the Stork REST pull path");
  const url = `${base}/v1/prices/latest?assets=${assets.join(",")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Stork REST ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  return res.json();
}
