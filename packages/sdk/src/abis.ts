/**
 * The viem ABIs the SDK calls — the **permissionless** account-facing surface (Doc 2 §5.1 "Act").
 *
 * The engine (`@sidekick/engine`'s `chain/abis.ts`) declares the *operator* surface (`checkpoint`,
 * `answerMarginCall`) + reads. The SDK is the *account* surface: the writes any EOA calls for itself
 * — `Vault.deposit/withdraw`, `PerpEngine.openPosition/closePosition`, `Pool.provideLiquidity/
 * withdrawLiquidity`, `AccountManager.linkIdentity` — plus the reads an agent needs to see its own
 * account (`positionOf`, `equityOf`, `freeCollateral`). Hand-written `as const` so viem infers exact
 * types and the SDK declares only the surface it uses.
 *
 * Verified against `packages/contracts/src/*` (the deployed contracts): all of these are
 * `external nonReentrant` and callable by `msg.sender` for its own account — NOT owner/operator-gated.
 *
 * @see packages/contracts/src/PerpEngine.sol · Vault.sol · Pool.sol · AccountManager.sol
 */

import { erc20Abi } from "viem";

export { erc20Abi };

/** PerpEngine — the account surface: open/close a position, read own position/equity/notional. */
export const PERP_ENGINE_ABI = [
  {
    type: "function",
    name: "openPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "side", type: "uint8" }, // 1 Long, 2 Short (0 Flat is rejected)
      { name: "notional", type: "uint256" }, // USDC 6dp
      { name: "margin", type: "uint256" }, // USDC 6dp
      { name: "mark", type: "uint256" }, // WAD 18dp
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "closePosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "mark", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "positionOf",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "side", type: "uint8" }, // 0 Flat, 1 Long, 2 Short
          { name: "entryNotional", type: "uint256" },
          { name: "entryMark", type: "uint256" },
          { name: "margin", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "equityOf",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "account", type: "address" },
      { name: "mark", type: "uint256" },
    ],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function",
    name: "notionalOf",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "account", type: "address" },
      { name: "mark", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Vault — deposit/withdraw free collateral, read own free collateral. */
export const VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "freeCollateral",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Pool — provide / withdraw liquidity (the LP surface), read capital + the slpUSDC share token. */
export const POOL_ABI = [
  {
    type: "function",
    name: "provideLiquidity",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdrawLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "mark", type: "uint256" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "capital",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lpToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

/** AccountManager — link an (optional) ERC-8004 identity to the caller (Doc 1 §8). */
export const ACCOUNT_MANAGER_ABI = [
  {
    type: "function",
    name: "linkIdentity",
    stateMutability: "nonpayable",
    inputs: [{ name: "identityId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "identityOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Circle GatewayWallet — `deposit(token, value)` moves USDC into the caller's Gateway unified balance
 * (the off-chain balance margin-call nanopayments draw against). Same call Circle's `GatewayClient`
 * makes, but signed by our wallet client so an external/Circle-Wallet signer can fund Gateway with no
 * raw key. ABI taken verbatim from `@circle-fin/x402-batching`'s bundled `GATEWAY_WALLET_ABI`.
 */
export const GATEWAY_WALLET_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * ERC-8004 Identity Registry — the canonical on-chain agent identity (an ERC-721 per agent). We use
 * the no-arg `register()` (mints an agentId to `msg.sender`, with `agentWallet` defaulting to the
 * caller), `setAgentWallet` (bind a *different* payee wallet with an EIP-712 proof from that wallet),
 * and the reads. Signatures verified against the deployed `IdentityRegistryUpgradeable`.
 */
export const IDENTITY_REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setAgentWallet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
] as const;

/**
 * ERC-8004 Reputation Registry — on-chain feedback keyed by agentId. SideKick writes a settled
 * margin-call nanopayment as a proof-of-payment feedback record (closing the discover→pay→record
 * loop), and reads an agent's running summary.
 */
export const REPUTATION_REGISTRY_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
] as const;

/** IOracleAdapter.getMark() → Mark{ int256 price18; uint64 timestampMs } — read the live mark for a tx. */
export const ORACLE_ADAPTER_ABI = [
  {
    type: "function",
    name: "getMark",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        name: "mark",
        components: [
          { name: "price18", type: "int256" },
          { name: "timestampMs", type: "uint64" },
        ],
      },
    ],
  },
] as const;
