/**
 * ERC-8004 ("Trustless Agents") — the on-chain agent identity + reputation registries SideKick links
 * its accounts to (Doc 1 §8). This is the standard that makes a SideKick trader a *discoverable,
 * reputation-bearing agent*, not just an anonymous EOA: an Identity Registry (ERC-721, one NFT per
 * agent) plus a Reputation Registry (feedback keyed by agentId).
 *
 * The registries are deployed at canonical CREATE2 vanity addresses (0x8004…) that are identical
 * across ~20 EVM chains — including **Arc Testnet (chain 5042002)**, where SideKick is live. The
 * addresses below are the canonical testnet deployment from the 8004 team's contracts repo, and
 * were **verified on-chain** (`eth_getCode` returns real bytecode on the Arc RPC) before being
 * committed here — not copied from a README on faith.
 *
 * `ValidationRegistry` has no canonical deployment yet (the spec marks it "under active update"), so
 * it is intentionally absent — trustless re-execution/validation is a later beat.
 *
 * @see https://eips.ethereum.org/EIPS/eip-8004
 * @see https://github.com/erc-8004/erc-8004-contracts (canonical addresses + verified Solidity)
 */

import type { Address } from "viem";
import { ARC } from "./constants.ts";

/** The two ERC-8004 registries SideKick uses (Identity + Reputation). */
export interface Erc8004Registries {
  /** Identity Registry (ERC-721): `register()` mints an agentId; `agentWallet` = payee address. */
  readonly identity: Address;
  /** Reputation Registry: `giveFeedback(agentId, …)` records on-chain feedback for an agent. */
  readonly reputation: Address;
}

/**
 * Canonical **testnet** ERC-8004 registry addresses (same on every testnet the 8004 team deployed
 * to, Arc Testnet included). Verified live on Arc (chain 5042002) via `eth_getCode`.
 */
export const ERC8004_TESTNET: Erc8004Registries = {
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
};

/** Canonical **mainnet** ERC-8004 registry addresses (for the eventual mainnet venue). */
export const ERC8004_MAINNET: Erc8004Registries = {
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
};

/** The ERC-8004 registries for a chain id (Arc Testnet → the canonical testnet deployment). */
export function erc8004For(chainId: number): Erc8004Registries {
  if (chainId === ARC.chainId) return ERC8004_TESTNET;
  throw new Error(`No ERC-8004 registry mapping for chain ${chainId}`);
}

/**
 * The EIP-712 domain the Identity Registry verifies `setAgentWallet` signatures against — taken
 * verbatim from the deployed `IdentityRegistryUpgradeable` (`__EIP712_init("ERC8004IdentityRegistry",
 * "1")`). `chainId` + `verifyingContract` (the Identity Registry address) complete the domain in the
 * standard EIP-712 way.
 */
export const ERC8004_IDENTITY_EIP712_DOMAIN = {
  name: "ERC8004IdentityRegistry",
  version: "1",
} as const;

/**
 * The EIP-712 typed-data the **new wallet** signs to prove control when binding it to an agentId via
 * `setAgentWallet(agentId, newWallet, deadline, signature)`. Field order/types match the deployed
 * contract's typehash exactly: `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`.
 * The contract recovers the signer and requires `recovered == newWallet`.
 */
export const ERC8004_AGENT_WALLET_SET_TYPES = {
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "owner", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * The portable, namespaced identifier for an agent: `eip155:<chainId>:<identityRegistry>/<agentId>`.
 * This is how an external system resolves a SideKick agent's identity/reputation across chains
 * (per the ERC-8004 spec's `namespace:chainId:registry` convention).
 */
export function agentNamespacedId(
  chainId: number,
  identityRegistry: Address,
  agentId: bigint,
): string {
  return `eip155:${chainId}:${identityRegistry}/${agentId.toString()}`;
}
