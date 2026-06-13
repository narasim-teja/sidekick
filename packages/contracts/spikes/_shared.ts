/**
 * Shared helpers for the Phase 0 spike runners.
 *
 * Loads the repo-root `.env`, builds viem clients against Arc testnet, and exposes the
 * funded account. Throwaway-grade — these belong to the spikes, not the venue.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arcTestnet } from "@sidekick/shared";
import {
  type Account,
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  webSocket,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root, two levels up from packages/contracts/spikes. */
export const REPO_ROOT = resolve(HERE, "../../..");

/**
 * Minimal `.env` loader. Bun auto-loads `.env` from CWD, but spikes are launched from the
 * package dir, so we read the root file explicitly and merge into `process.env` (without
 * overwriting anything already set, e.g. real shell exports).
 */
export function loadRootEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(REPO_ROOT, ".env"), "utf8");
  } catch {
    return; // no .env — rely on whatever is already in the environment
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Require an env var, throwing a clear error if missing. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (set it in .env at the repo root)`);
  return v;
}

/** The funded Arc-testnet account from PRIVATE_KEY. */
export function spikeAccount(): Account {
  const pk = requireEnv("PRIVATE_KEY");
  return privateKeyToAccount(pk as `0x${string}`);
}

/** A viem public client over HTTP (RPC resolved from env, incl. Alchemy override). */
export function httpClient(): PublicClient {
  return createPublicClient({ chain: arcTestnet(), transport: http() }) as PublicClient;
}

/** A viem public client over WebSocket (for per-block subscriptions). */
export function wssClient(): PublicClient {
  return createPublicClient({ chain: arcTestnet(), transport: webSocket() }) as PublicClient;
}

/** A viem wallet client over HTTP for sending transactions. */
export function walletClient(account: Account = spikeAccount()): WalletClient {
  return createWalletClient({ account, chain: arcTestnet(), transport: http() });
}

/** Pretty section header for spike logs. */
export function banner(title: string): void {
  console.log(`\n${"─".repeat(72)}\n  ${title}\n${"─".repeat(72)}`);
}
