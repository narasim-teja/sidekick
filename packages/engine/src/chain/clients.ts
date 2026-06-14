/**
 * viem clients for the live engine — a public client (reads + waits) and a wallet client (the
 * trusted operator that triggers `checkpoint` / `answerMarginCall`). Built from the shared Arc
 * chain definition + env, so the RPC/WSS and operator key flow from one place.
 *
 * @see packages/shared/src/chain.ts (the Arc chain definition)
 */

import { ARC, arcTestnet, rpcUrl, wssUrl } from "@sidekick/shared";
import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  webSocket,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The Arc chain object, resolved from env. */
export function arcChain(env: Record<string, string | undefined> = process.env): Chain {
  return arcTestnet(env);
}

/**
 * A public client over HTTP (the default read path; prefers an Alchemy override if set). JSON-RPC
 * batching is ON: every reconcile tick fans out ~2 reads per account (`positionOf` + `freeCollateral`)
 * across every market in parallel — dozens of concurrent `eth_call`s each ~2s — which a free-tier RPC
 * rate-limits into "HTTP request failed", stalling the reconcile (and with it the margin-call /
 * nanopayment flow). `batch` coalesces those concurrent calls into batched requests, cutting the
 * request count by ~an order of magnitude so the per-block reads land reliably.
 */
export function publicClient(env: Record<string, string | undefined> = process.env): PublicClient {
  return createPublicClient({
    chain: arcChain(env),
    transport: http(rpcUrl(env), { batch: true }),
  }) as PublicClient;
}

/**
 * A public client pinned to the PUBLIC Arc RPC for `eth_getLogs` scans. The public RPC allows a
 * 10,000-block range, whereas free-tier providers (Alchemy: 10 blocks) are far too restrictive for
 * the event backfill. The high-frequency per-block reads can still use the (possibly faster)
 * Alchemy client; only the log scan needs the wide range, so it gets its own client.
 */
export function logsClient(env: Record<string, string | undefined> = process.env): PublicClient {
  const url = env.ARC_LOGS_RPC_URL || ARC.rpcUrl; // public Arc RPC (wide getLogs range)
  return createPublicClient({ chain: arcChain(env), transport: http(url) }) as PublicClient;
}

/** Max `eth_getLogs` block span on the public Arc RPC (its documented limit). */
export const ARC_LOGS_MAX_RANGE = 10_000n;

/** A public client over WebSocket — used to subscribe to new Arc blocks (the loop heartbeat). */
export function wsClient(env: Record<string, string | undefined> = process.env): PublicClient {
  return createPublicClient({
    chain: arcChain(env),
    transport: webSocket(wssUrl(env)),
  }) as PublicClient;
}

/** The operator account from `PRIVATE_KEY` (the engine is the venue owner in the POC). */
export function operatorAccount(env: Record<string, string | undefined> = process.env): Account {
  const pk = env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY is required to run the engine (the checkpoint operator)");
  return privateKeyToAccount(pk as `0x${string}`);
}

/** A wallet client for the operator — sends `checkpoint` / `answerMarginCall` / settle txns. */
export function operatorWallet(
  env: Record<string, string | undefined> = process.env,
): WalletClient<ReturnType<typeof http>, Chain, Account> {
  return createWalletClient({
    account: operatorAccount(env),
    chain: arcChain(env),
    transport: http(rpcUrl(env)),
  });
}
