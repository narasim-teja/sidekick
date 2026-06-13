/**
 * SideKick — canonical constants for Arc Testnet, Circle Gateway, Stork, and Chainlink.
 *
 * Single source of truth for the deployment facts in Doc 1 §9. Addresses are public and
 * safe to commit; secrets (private key, API keys) live only in `.env` and are read via
 * `process.env` at call sites, never hard-coded here.
 *
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §9 (Confirmed deployment facts)
 */

import type { Address } from "viem";

// ── Arc Testnet ────────────────────────────────────────────────────────────────
export const ARC = {
  chainId: 5042002,
  name: "Arc Testnet",
  /** Default public RPC. Override via env (e.g. an Alchemy URL) — see `rpcUrl()`. */
  rpcUrl: "https://rpc.testnet.arc.network",
  wssUrl: "wss://rpc.testnet.arc.network",
  explorerUrl: "https://testnet.arcscan.app",
  faucetUrl: "https://faucet.circle.com",
  /** Arc uses USDC as the native gas token, with 18 decimals as gas. */
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
} as const;

/**
 * Resolve the Arc RPC URL, preferring an env override (Alchemy or other provider)
 * over the public default. Falls back to `ARC.rpcUrl` when nothing is set.
 */
export function rpcUrl(env: Record<string, string | undefined> = process.env): string {
  return env.ALCHEMY_ARC_RPC_URL || env.ARC_RPC_URL || ARC.rpcUrl;
}

/** Resolve the Arc WSS URL, preferring an env override over the public default. */
export function wssUrl(env: Record<string, string | undefined> = process.env): string {
  return env.ARC_WSS_URL || ARC.wssUrl;
}

// ── Circle Gateway (nanopayments / Layer B) ──────────────────────────────────────
// The off-chain authorization rail. Primary surface is the @circle-fin/x402-batching
// SDK (chain alias below); the raw contracts are the documented fallback. See
// docs/02 Phase 0 Spike C and the `circle-gateway-sdk` memory.
export const GATEWAY = {
  /** Chain alias the @circle-fin/x402-batching SDK expects for Arc testnet. */
  chainAlias: "arcTestnet",
  /** Raw Gateway Wallet (deposit / burn) — fallback path. */
  walletAddress: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as Address,
  /** Raw Gateway Minter (gatewayMint) — fallback path. */
  minterAddress: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as Address,
  /** Gateway domain id for Arc testnet. */
  arcDomainId: 26,
} as const;

// ── Stork oracle (mark option A) ─────────────────────────────────────────────────
export const STORK = {
  /** Stork pull-oracle contract on Arc testnet. */
  contractAddress: "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62" as Address,
  /** REST base for fetching signed price updates (Basic auth; key in env). */
  restUrl: "https://rest.jp.stork-oracle.network",
} as const;

// ── Chainlink Data Streams (mark option B — the pull path that mirrors Stork) ──────
// The REST Data Engine serves signed `fullReport` blobs (HMAC auth via CHAINLINK_API_KEY/SECRET);
// the on-chain Verifier proxy validates them. `verifier`/`feeToken` are STUBS (undefined) — the Arc
// Data Streams Verifier proxy + fee-token addresses are not yet confirmed, so they are supplied via
// env (CHAINLINK_VERIFIER / CHAINLINK_FEE_TOKEN) until pinned. Until then the on-chain
// ChainlinkAdapter runs in relay mode (owner seeds marks via `pushMarkUnverified`).
export const CHAINLINK = {
  /** Data Streams REST base (testnet Data Engine). Override via CHAINLINK_STREAMS_HOST. */
  streamsHost: "api.testnet-dataengine.chain.link",
  /** Arc Data Streams Verifier proxy — UNCONFIRMED; supply via CHAINLINK_VERIFIER when known. */
  verifier: undefined as Address | undefined,
  /** Verify fee token (wrapped-native or LINK) — UNCONFIRMED; supply via CHAINLINK_FEE_TOKEN. */
  feeToken: undefined as Address | undefined,
  /**
   * The CRE **KeystoneForwarder** on Arc Testnet — the Chainlink contract that delivers DON-attested
   * workflow reports by calling our `MarkReceiver.onReport`. That on-chain call is the qualifying
   * Chainlink state change (Connect-the-World). Verified from the CRE Forwarder Directory; chain name
   * for project.yaml is `"arc-testnet"`.
   */
  arcForwarder: "0x76c9cf548b4179F8901cda1f8623568b58215E62" as Address,
  /** The CRE chain-name string Arc testnet uses in project.yaml / getNetwork. */
  arcChainName: "arc-testnet",
} as const;

/** Resolve the Chainlink Data Streams REST host, preferring an env override over the default. */
export function chainlinkStreamsHost(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CHAINLINK_STREAMS_HOST || CHAINLINK.streamsHost;
}

// ── Additional oracle fallbacks (live on Arc per Doc 1 §9) ────────────────────────
// Pyth and RedStone are also available; addresses filled in if/when an adapter is added.
export const ORACLE_FALLBACKS = {
  pyth: undefined as Address | undefined,
  redstone: undefined as Address | undefined,
} as const;
