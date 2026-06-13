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
