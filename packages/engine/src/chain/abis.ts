/**
 * Minimal viem ABIs for the venue contracts the engine touches. Hand-written `as const` (not the
 * full Foundry artifacts) so viem infers precise types and the engine declares exactly the surface
 * it uses: read positions/pool/market state, and write `checkpoint` / `answerMarginCall`.
 *
 * These mirror the deployed contracts (`packages/contracts/src/*`). The structs (Position,
 * MarketParams, Mark) match the on-chain layout so decoded tuples line up.
 *
 * @see packages/shared/src/deployments.ts (the addresses these ABIs are called at)
 */

/** IOracleAdapter.getMark() → Mark{ int256 price18; uint64 timestampMs } + source(). */
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
  {
    type: "function",
    name: "source",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

/** PerpEngine — the §4.3 state machine: read positions/equity, write checkpoint + margin-call. */
export const PERP_ENGINE_ABI = [
  {
    type: "function",
    name: "checkpoint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "mark", type: "uint256" },
      { name: "accounts", type: "address[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "answerMarginCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
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
  {
    type: "function",
    name: "smoothSkewPrev",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function",
    name: "checkpointCount",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "PositionOpened",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "side", type: "uint8", indexed: false },
      { name: "notional", type: "uint256", indexed: false },
      { name: "margin", type: "uint256", indexed: false },
      { name: "mark", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PositionClosed",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "realizedPnl", type: "int256", indexed: false },
      { name: "mark", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Vault — read free collateral (the engine clamps margin-call answers to it). */
export const VAULT_ABI = [
  {
    type: "function",
    name: "freeCollateral",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Pool — read capital / gap fund / net exposure for the per-block state snapshot. */
export const POOL_ABI = [
  {
    type: "function",
    name: "capital",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "gapFund",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "netQtyWad",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function",
    name: "fundingAccrued",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function",
    name: "exposure",
    stateMutability: "view",
    inputs: [{ name: "mark", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "equity",
    stateMutability: "view",
    inputs: [{ name: "mark", type: "uint256" }],
    outputs: [{ type: "int256" }],
  },
] as const;

/** MarketRegistry — read a market's params + pool + oracle adapter. */
/** The `MarketParams` tuple shape, shared by `getParams` / `setParams` (and nested in `getMarket`). */
const MARKET_PARAMS_TUPLE = {
  name: "params",
  type: "tuple",
  components: [
    { name: "m", type: "int256" },
    { name: "alpha", type: "int256" },
    { name: "lambda", type: "int256" },
    { name: "rMax", type: "int256" },
    { name: "k", type: "uint256" },
  ],
} as const;

export const MARKET_REGISTRY_ABI = [
  {
    type: "function",
    name: "getMarket",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "exists", type: "bool" },
          MARKET_PARAMS_TUPLE,
          { name: "pool", type: "address" },
          { name: "oracleAdapter", type: "address" },
          { name: "feedId", type: "bytes32" },
          { name: "symbol", type: "string" },
        ],
      },
    ],
  },
  {
    // Hot-path getter for just the economic params (reverts MarketNotFound if unknown).
    type: "function",
    name: "getParams",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [MARKET_PARAMS_TUPLE],
  },
  {
    // Owner-only params update — the engine uses this to sync the demo maintenance fraction on-chain.
    type: "function",
    name: "setParams",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { ...MARKET_PARAMS_TUPLE, name: "params" },
    ],
    outputs: [],
  },
] as const;
