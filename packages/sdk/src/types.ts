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
  /** Optional ERC-8004 identity token id to link to the account (Doc 1 §8). */
  identityId?: bigint;
}

/** The outcome of an onboarding pass — which steps ran + their tx hashes. */
export interface OnboardResult {
  address: `0x${string}`;
  vaultDepositTx?: Hex;
  gatewayDepositTx?: Hex;
  identityTx?: Hex;
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
