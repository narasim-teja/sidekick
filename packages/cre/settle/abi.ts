/**
 * ABIs for the CRE settlement workflow: read the live mark + open-account set on-chain, then write a
 * settlement report the forwarder delivers to {CheckpointSettler.onReport}, which calls
 * {PerpEngine.checkpoint}. See packages/contracts/src/oracle/CheckpointSettler.sol.
 */

/** PerpEngine.openAccounts(marketId) — the checkpoint account set, read from chain state. */
export const PERP_ENGINE_READ_ABI = [
  {
    type: "function",
    name: "openAccounts",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "checkpointCount",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** The MarkReceiver (or any IOracleAdapter) getMark() — the verified mark to settle at. */
export const ORACLE_GETMARK_ABI = [
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

/** The SettleReport struct CheckpointSettler.onReport decodes — must match the Solidity struct. */
export const SETTLE_REPORT_COMPONENTS = [
  { name: "marketId", type: "bytes32" },
  { name: "mark", type: "uint256" },
  { name: "accounts", type: "address[]" },
] as const;
