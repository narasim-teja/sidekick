/**
 * SideKick mark-feed CRE workflow — the qualifying Chainlink integration.
 *
 * On a cron schedule, this workflow (running on the Chainlink DON):
 *   1. Fetches a REAL Chainlink Data Streams report for the configured feed (LINK/USD) over the
 *      Data Streams REST API, authenticating with an HMAC-SHA256 signature computed INSIDE the
 *      workflow (the WASM sandbox has no node:crypto — see ./hmac.ts).
 *   2. Decodes the v3 report's price (int192, 18-dp) — the verified Chainlink price.
 *   3. Reaches DON consensus on the price, signs a report, and calls `onReport(metadata, report)` on
 *      our on-chain {MarkReceiver} via the Arc KeystoneForwarder.
 *
 * THE QUALIFYING STATE CHANGE: step 3 is the Chainlink KeystoneForwarder (a Chainlink contract)
 * calling our contract on Arc to write the mark. That is "a Chainlink service making an on-chain
 * state change inside a smart contract" — the Connect-the-World requirement — and it stacks with the
 * CRE bounty (the workflow IS the integration). The venue engine then reads that mark via
 * IOracleAdapter.getMark() exactly as it reads Stork, with `chainlink-live` provenance.
 *
 * Run locally (qualifies for the hackathon per the Chainlink team — no DON deploy needed):
 *   cre workflow simulate ./markfeed --broadcast --target <arc-target>
 */

import {
  bytesToHex,
  ConsensusAggregationByFields,
  cre,
  getNetwork,
  type HTTPSendRequester,
  median,
  prepareReportRequest,
  type Runtime,
  TxStatus,
} from "@chainlink/cre-sdk";
import { type Address, encodeAbiParameters } from "viem";
import { z } from "zod";
import { MARK_REPORT_COMPONENTS } from "./abi.ts";
import { hmacSha256, sha256, toHexStr, utf8 } from "./hmac.ts";

export const configSchema = z.object({
  schedule: z.string(),
  /** Data Streams REST host, e.g. api.testnet-dataengine.chain.link. */
  streamsHost: z.string(),
  /** The 32-byte Data Streams feed id (e.g. LINK/USD). */
  feedId: z.string(),
  /** The workflow owner (for the Vault DON secret lookup). */
  owner: z.string(),
  evms: z.array(
    z.object({
      /** The deployed MarkReceiver consumer address on Arc. */
      markReceiverAddress: z.string(),
      chainSelectorName: z.string(),
      gasLimit: z.string(),
    }),
  ),
});

type Config = z.infer<typeof configSchema>;

/** The decoded Data Streams price we agree on across the DON. */
interface MarkData {
  price18: bigint;
  observedMs: number;
}

/**
 * Fetch + decode the latest Data Streams report for the feed. Runs per-node; the HMAC is computed
 * here (no node:crypto in the sandbox). The DON then aggregates the per-node results by median.
 */
const fetchMark = (
  sendRequester: HTTPSendRequester,
  config: Config & { apiKey: string; apiSecret: string },
): MarkData => {
  const path = `/api/v1/reports/latest?feedID=${config.feedId}`;
  // Data Streams auth: HMAC-SHA256 over "<METHOD> <path> <sha256hex(body)> <apiKey> <ts>".
  const ts = Date.now();
  const bodyHash = toHexStr(sha256(utf8("")));
  const toSign = `GET ${path} ${bodyHash} ${config.apiKey} ${ts}`;
  const sig = toHexStr(hmacSha256(utf8(config.apiSecret), utf8(toSign)));

  const response = sendRequester
    .sendRequest({
      url: `https://${config.streamsHost}${path}`,
      method: "GET",
      headers: {
        Authorization: config.apiKey,
        "X-Authorization-Timestamp": String(ts),
        "X-Authorization-Signature-SHA256": sig,
      },
    })
    .result();

  if (response.statusCode !== 200) {
    throw new Error(`Data Streams HTTP ${response.statusCode}`);
  }
  const body = JSON.parse(Buffer.from(response.body).toString("utf-8")) as {
    report: { fullReport: string; observationsTimestamp: number };
  };
  const { price18, observedMs } = decodeReport(body.report.fullReport as `0x${string}`);
  return { price18, observedMs };
};

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const apiKey = runtime.getSecret({ id: "CHAINLINK_API_KEY" }).result().value;
  const apiSecret = runtime.getSecret({ id: "CHAINLINK_API_SECRET" }).result().value;

  runtime.log(`fetching Data Streams report for feed ${runtime.config.feedId}`);
  const mark = new cre.capabilities.HTTPClient()
    .sendRequest(
      runtime,
      fetchMark,
      ConsensusAggregationByFields<MarkData>({ price18: median, observedMs: median }),
    )({ ...runtime.config, apiKey, apiSecret })
    .result();

  runtime.log(`consensus mark price18=${mark.price18.toString()} observedMs=${mark.observedMs}`);

  // The report payload is just the ABI-encoded MarkReport struct. The DON signs it and the
  // KeystoneForwarder calls `onReport(metadata, <this payload>)` on MarkReceiver, which abi.decodes
  // it — so we pass the BARE struct here, NOT an onReport() call (the forwarder does that wrapping).
  const reportPayload = encodeAbiParameters(
    [{ type: "tuple", components: MARK_REPORT_COMPONENTS as never }],
    [{ price18: mark.price18, timestampMs: BigInt(mark.observedMs) }] as never,
  );

  const evmConfig = runtime.config.evms[0];
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`unknown chain ${evmConfig.chainSelectorName}`);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  // DON consensus + signing → the forwarder delivers this to MarkReceiver.onReport (the state change).
  const report = runtime.report(prepareReportRequest(reportPayload)).result();
  const resp = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.markReceiverAddress as Address,
      report,
      gasConfig: { gasLimit: evmConfig.gasLimit },
    })
    .result();

  if (resp.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`write failed: ${resp.errorMessage || resp.txStatus}`);
  }
  const txHash = bytesToHex(resp.txHash || new Uint8Array(32));
  runtime.log(`✓ MarkReceiver.onReport written on-chain: ${txHash}`);
  return txHash;
};

export const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

// ── Data Streams v3 report decoding (the report blob is ABI-encoded) ──────────────────
import { decodeAbiParameters } from "viem";

const REPORT_V3 = [
  { type: "bytes32" },
  { type: "uint32" },
  { type: "uint32" },
  { type: "uint192" },
  { type: "uint192" },
  { type: "uint32" },
  { type: "int192" }, // price (index 6), 18-dp
  { type: "int192" },
  { type: "int192" },
] as const;

/** Decode `fullReport` → price18 (18-dp) + observation time (ms). */
function decodeReport(fullReport: `0x${string}`): { price18: bigint; observedMs: number } {
  const [, blob] = decodeAbiParameters(
    [
      { type: "bytes32[3]" },
      { type: "bytes" },
      { type: "bytes32[]" },
      { type: "bytes32[]" },
      { type: "bytes32" },
    ],
    fullReport,
  );
  const d = decodeAbiParameters(REPORT_V3, blob as `0x${string}`);
  return { price18: d[6] as bigint, observedMs: Number(d[2]) * 1000 };
}
