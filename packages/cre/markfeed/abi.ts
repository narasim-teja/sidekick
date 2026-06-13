/**
 * The minimal ABI of our on-chain CRE consumer, {@link file://../../contracts/src/oracle/MarkReceiver.sol}.
 * The workflow encodes a call to `onReport(metadata, report)`; the DON signs it and the Arc
 * KeystoneForwarder delivers it — that on-chain `onReport` call is the qualifying Chainlink state change.
 */
export const MARK_RECEIVER_ABI = [
  {
    type: "function",
    name: "onReport",
    stateMutability: "nonpayable",
    inputs: [
      { name: "metadata", type: "bytes" },
      { name: "report", type: "bytes" },
    ],
    outputs: [],
  },
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
    name: "reportCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** The `MarkReport` struct the consumer's `onReport` decodes — must match MarkReceiver.MarkReport. */
export const MARK_REPORT_COMPONENTS = [
  { name: "price18", type: "int256" },
  { name: "timestampMs", type: "uint64" },
] as const;
