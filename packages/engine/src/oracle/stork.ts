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
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
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

// ── REST pull path (push a fresh signed mark on-chain, then read it) ──────────────────
//
// The on-chain Stork feed on Arc testnet is stale (BTCUSD last pushed ~124 days ago). To get a LIVE,
// moving mark, the venue pulls a freshly-signed price from Stork's REST API and pushes it on-chain via
// `updateTemporalNumericValuesV1` (the "pull oracle" pattern). The REST→on-chain mapping below is the
// exact one the official Stork chain-pusher uses (`getUpdatePayload`); there is no official JS encoder,
// so we hand-roll it in viem. Feed id = `keccak256(utf8(symbol))` (matches `encoded_asset_id`).
//
// @see https://docs.stork.network/getting-started/putting-data-on-chain

/** One signed Stork price as the REST `/v1/prices/latest` endpoint returns it (the fields we use). */
interface StorkSignedPrice {
  encoded_asset_id: `0x${string}`;
  price: string; // quantized value, decimal string, ×1e18
  timestamped_signature: {
    signature: { r: `0x${string}`; s: `0x${string}`; v: `0x${string}` };
    timestamp: number | string; // nanoseconds (the SIGNED timestamp — use this, not the top-level one)
  };
  publisher_merkle_root: `0x${string}`;
  calculation_alg: { checksum: string }; // hex WITHOUT a 0x prefix
}

/** The on-chain `StorkStructs.TemporalNumericValueInput` tuple, ready to pass to viem. */
export interface TemporalNumericValueInput {
  temporalNumericValue: { timestampNs: bigint; quantizedValue: bigint };
  id: `0x${string}`;
  publisherMerkleRoot: `0x${string}`;
  valueComputeAlgHash: `0x${string}`;
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
}

/** The minimal Stork contract ABI for the pull-update push + fee + unsafe read. */
export const STORK_UPDATE_ABI = [
  {
    type: "function",
    name: "getUpdateFeeV1",
    stateMutability: "view",
    inputs: [
      {
        name: "updateData",
        type: "tuple[]",
        components: [
          {
            name: "temporalNumericValue",
            type: "tuple",
            components: [
              { name: "timestampNs", type: "uint64" },
              { name: "quantizedValue", type: "int192" },
            ],
          },
          { name: "id", type: "bytes32" },
          { name: "publisherMerkleRoot", type: "bytes32" },
          { name: "valueComputeAlgHash", type: "bytes32" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "v", type: "uint8" },
        ],
      },
    ],
    outputs: [{ name: "feeAmount", type: "uint256" }],
  },
  {
    type: "function",
    name: "updateTemporalNumericValuesV1",
    stateMutability: "payable",
    inputs: [
      {
        name: "updateData",
        type: "tuple[]",
        components: [
          {
            name: "temporalNumericValue",
            type: "tuple",
            components: [
              { name: "timestampNs", type: "uint64" },
              { name: "quantizedValue", type: "int192" },
            ],
          },
          { name: "id", type: "bytes32" },
          { name: "publisherMerkleRoot", type: "bytes32" },
          { name: "valueComputeAlgHash", type: "bytes32" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "v", type: "uint8" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/**
 * Fetch fresh signed Stork prices over REST (Basic auth, `STORK_API_KEY`) and map each to the
 * on-chain `TemporalNumericValueInput` tuple. Asset ids are plain symbols (e.g. `"BTCUSD"`). Returns
 * one input per asset, in the order Stork returns them, ready to pass to {@link pushStorkUpdate}.
 */
export async function fetchStorkUpdate(
  assets: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<TemporalNumericValueInput[]> {
  const apiKey = env.STORK_API_KEY;
  const base = env.STORK_REST_URL || STORK.restUrl;
  if (!apiKey) throw new Error("STORK_API_KEY is required for the Stork REST pull path");
  const url = `${base}/v1/prices/latest?assets=${assets.join(",")}`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${apiKey}` } });
  if (!res.ok) {
    throw new Error(`Stork REST ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  const body = (await res.json()) as {
    data?: Record<string, { stork_signed_price: StorkSignedPrice }>;
  };
  const data = body.data ?? {};
  return Object.values(data).map((entry) => mapSignedPrice(entry.stork_signed_price));
}

/** Map one REST `stork_signed_price` to the on-chain `TemporalNumericValueInput` tuple (exact pusher mapping). */
export function mapSignedPrice(p: StorkSignedPrice): TemporalNumericValueInput {
  const sig = p.timestamped_signature;
  return {
    temporalNumericValue: {
      timestampNs: BigInt(sig.timestamp), // the SIGNED ns timestamp
      quantizedValue: BigInt(p.price), // int192, ×1e18
    },
    id: p.encoded_asset_id,
    publisherMerkleRoot: p.publisher_merkle_root,
    // The REST checksum has NO 0x prefix; the on-chain bytes32 needs one.
    valueComputeAlgHash: `0x${p.calculation_alg.checksum}` as `0x${string}`,
    r: sig.signature.r,
    s: sig.signature.s,
    v: Number.parseInt(sig.signature.v.slice(2), 16), // "0x1c" → 28
  };
}

/** The result of pushing a Stork update on-chain. */
export interface StorkPushResult {
  txHash: Hex;
  fee: bigint;
  assets: number;
}

/**
 * Push fresh signed Stork prices on-chain: read the required fee via `getUpdateFeeV1`, then send
 * `updateTemporalNumericValuesV1{value: fee}`. The fee is paid as native `msg.value` (on Arc the
 * native gas token is USDC). Returns the tx hash + fee. After this lands, `getTemporalNumericValueV1`
 * (and our `StorkAdapter.getMark`) return the fresh value — no more `StaleValue`/`NotFound`.
 */
export async function pushStorkUpdate(
  pub: PublicClient,
  wallet: WalletClient<Transport, Chain, Account>,
  updateData: TemporalNumericValueInput[],
  env: Record<string, string | undefined> = process.env,
): Promise<StorkPushResult> {
  if (updateData.length === 0) throw new Error("no Stork updates to push");
  const storkAddress = (env.STORK_CONTRACT_ADDRESS || STORK.contractAddress) as Address;
  const fee = (await pub.readContract({
    address: storkAddress,
    abi: STORK_UPDATE_ABI,
    functionName: "getUpdateFeeV1",
    args: [updateData],
  })) as bigint;
  const txHash = await wallet.writeContract({
    address: storkAddress,
    abi: STORK_UPDATE_ABI,
    functionName: "updateTemporalNumericValuesV1",
    args: [updateData],
    value: fee,
    chain: wallet.chain,
    account: wallet.account,
  });
  return { txHash, fee, assets: updateData.length };
}

/**
 * Fetch + push in one call: pull fresh signed prices for `assets` over REST and land them on-chain.
 * Convenience wrapper for the engine's per-tick (or periodic) mark refresh.
 */
export async function refreshStorkMarks(
  pub: PublicClient,
  wallet: WalletClient<Transport, Chain, Account>,
  assets: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<StorkPushResult> {
  const updateData = await fetchStorkUpdate(assets, env);
  return pushStorkUpdate(pub, wallet, updateData, env);
}
