/**
 * The SDK's public types. We **re-export the engine's per-block state types verbatim** (Doc 2 §5.1:
 * "re-export the engine's `MarketBlockState` and the shared market/param types so consumers never
 * hand-roll them") — the SDK is the ergonomic wrapper, not a parallel type universe. SDK-specific
 * config/action types are added here.
 *
 * @see packages/engine/src/state.ts (the canonical per-block payload)
 * @see packages/shared/src/markets.ts (market configs + params)
 */

import type { Account, Hex } from "viem";

/**
 * How the SDK BROADCASTS on-chain writes (open/close/deposit/approve/…). Default is the viem wallet
 * client (the account signs + the SDK broadcasts). A **Circle developer-controlled wallet** can't
 * return a viem-broadcastable signed tx — Circle broadcasts via its own API — so the Circle path
 * supplies a `Broadcaster` that hands the structured call to Circle and returns the on-chain txHash.
 * This is the seam that makes full Circle-MPC custody work end-to-end (writes + signing), no raw key.
 */
export interface Broadcaster {
  /**
   * Broadcast a contract call and return the on-chain tx hash once it lands. Receives the structured
   * call (abi + function + args) — not pre-encoded calldata — because Circle's developer-controlled
   * API takes `abiFunctionSignature` + `abiParameters`, the proven path for EOA wallets on Arc.
   */
  // biome-ignore lint/suspicious/noExplicitAny: abi/args are a union over the SDK's hand-written ABIs.
  write(params: {
    to: Hex;
    abi: any;
    functionName: string;
    args: any[];
    value?: bigint;
  }): Promise<Hex>;
}

// The engine's state payload — the contract with consumers (WS `block` frames + REST).
export type {
  EngineStatus,
  MarketBlockState,
  PoolState,
  PositionState,
  SettlementEvent,
  VenueDescriptor,
  VenueMarketDescriptor,
} from "@sidekick/engine/state";

// The shared market vocabulary.
export type { MarketConfig, MarketParams, MarketSymbol } from "@sidekick/shared";

/** Position side as the consumer expresses it. */
export type Side = "long" | "short";

/**
 * How the SDK signs — either a raw private key (demo/throwaway) OR a viem {@link Account} (so the
 * SDK is KMS/hardware-wallet ready, not demo-only). Exactly one is required.
 */
export type Signer =
  | { privateKey: Hex; account?: never }
  | { account: Account; privateKey?: never };

/** Construction config for a {@link SideKick} client. */
export type SideKickConfig = Signer & {
  /**
   * The network. Only `"arc-testnet"` (chain 5042002) is live; kept explicit so the chain id is
   * never guessed. Defaults to `"arc-testnet"`.
   */
  network?: "arc-testnet";
  /**
   * The engine service base URL (REST + the WS stream). Defaults to `http://localhost:8787`
   * (the engine's default port). The WS URL is derived from it unless `wsUrl` is set.
   */
  engineUrl?: string;
  /** Override the WS URL (otherwise derived from `engineUrl` by swapping http→ws + `/ws`). */
  wsUrl?: string;
  /** Override the chain RPC URL (otherwise the shared Arc default / env). */
  rpcUrl?: string;
  /**
   * How on-chain writes are broadcast. Omit for the default viem wallet-client path (the `account`
   * signs and the SDK broadcasts). Pass a {@link Broadcaster} (e.g. from `circleBroadcaster`) to route
   * writes through Circle's developer-controlled transaction API — required when the signer is a Circle
   * MPC wallet, which can't return a viem-broadcastable signed tx.
   */
  broadcaster?: Broadcaster;
};

/** Options for opening a position. Provide `notional` directly, or `collateral`+`leverage` sugar. */
export interface OpenOptions {
  market: import("@sidekick/shared").MarketSymbol;
  side: Side;
  /** Margin (collateral) to post, decimal USDC string (e.g. "20"). */
  collateral: string;
  /**
   * Leverage — client-side sugar: `notional = collateral × leverage` (Doc 3 §8; the venue takes
   * `{notional, margin}`, not a leverage primitive). Mutually exclusive with `notional`.
   */
  leverage?: number;
  /** Explicit notional, decimal USDC string. Mutually exclusive with `leverage`. */
  notional?: string;
  /**
   * Mark to price the open at, decimal USD string. Omit to have the SDK read the live on-chain mark
   * from the market's oracle adapter.
   */
  mark?: string;
}

/** Options for onboarding an account (one flow: trading collateral + Gateway + optional identity). */
export interface OnboardOptions {
  /** USDC to deposit into the Vault as trading collateral (decimal string). Omit to skip. */
  depositUSDC?: string;
  /**
   * USDC to deposit into the Circle Gateway unified balance (decimal string) — the off-chain
   * balance margin-call nanopayments draw against (Doc 1 §5 Layer B). Omit to skip.
   */
  gatewayUSDC?: string;
  /**
   * Link an already-minted ERC-8004 `agentId` to the account in the venue (Doc 1 §8). Use this if the
   * agent registered elsewhere. To mint a fresh identity in the same onboard pass, use
   * {@link registerIdentity} instead (mutually exclusive; `identityId` wins if both are set).
   */
  identityId?: bigint;
  /**
   * Register this account as a real ERC-8004 agent on Arc's canonical Identity Registry during
   * onboarding (mints an identity NFT, costs USDC gas), then link the minted `agentId` in-venue.
   * Mutually exclusive with {@link identityId}.
   */
  registerIdentity?: boolean;
}

/** The outcome of an onboarding pass — which steps ran + their tx hashes. */
export interface OnboardResult {
  address: `0x${string}`;
  vaultDepositTx?: Hex;
  gatewayDepositTx?: Hex;
  identityTx?: Hex;
  /** The ERC-8004 agentId minted, if `registerIdentity` was set. */
  agentId?: bigint;
}

/** A consumer's own account view in one market (joined from on-chain reads). */
export interface AccountView {
  address: `0x${string}`;
  market: import("@sidekick/shared").MarketSymbol;
  side: "flat" | "long" | "short";
  /** Position notional at entry (decimal USDC). */
  entryNotional: string;
  /** Entry mark (decimal USD). */
  entryMark: string;
  /** Posted margin (decimal USDC). */
  margin: string;
  /** Equity at `mark` = margin + unrealized price PnL (decimal USDC, signed). */
  equity: string;
  /** Un-utilized collateral in the Vault (decimal USDC). */
  freeCollateral: string;
}
