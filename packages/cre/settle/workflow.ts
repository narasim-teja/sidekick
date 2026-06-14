/**
 * SideKick settlement CRE workflow — CRE as the Layer-C settlement orchestrator (Doc 2 §6.1 step 3).
 *
 * On a cron schedule, this workflow (running on the Chainlink DON):
 *   1. Reads the current verified mark on-chain from MarkReceiver.getMark() (delivered by the
 *      mark-feed workflow) and the open-account set from PerpEngine.openAccounts() — BOTH read from
 *      chain state via the CRE EVM client, so the account set is computed decentralized, not trusted
 *      from an off-chain list.
 *   2. Reaches DON consensus, signs a SettleReport, and the Arc KeystoneForwarder calls
 *      CheckpointSettler.onReport — which calls PerpEngine.checkpoint(marketId, mark, accounts).
 *
 * THE QUALIFYING STATE CHANGE (and the higher-value half of Phase 6): step 2 has a Chainlink contract
 * (the forwarder) drive the venue's authoritative §4.3 settlement — funding, margin, decrement — on
 * Arc. CRE is now the verifiable settlement orchestrator, not just the oracle delivery.
 *
 * Run: cre workflow simulate ./settle --broadcast --target arc --trigger-index 0
 */

import {
  bytesToHex,
  cre,
  encodeCallMsg,
  getNetwork,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  type Runtime,
  TxStatus,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  zeroAddress,
} from "viem";
import { z } from "zod";
import { ORACLE_GETMARK_ABI, PERP_ENGINE_READ_ABI, SETTLE_REPORT_COMPONENTS } from "./abi.ts";

export const configSchema = z.object({
  schedule: z.string(),
  /** The bytes32 market id (right-padded "LINK-PERP", matching the on-chain registry key). */
  marketId: z.string(),
  evms: z.array(
    z.object({
      /** The PerpEngine to checkpoint (read openAccounts; write via the settler). */
      perpEngineAddress: z.string(),
      /** The MarkReceiver the mark-feed workflow writes (read getMark). */
      markReceiverAddress: z.string(),
      /** The CheckpointSettler consumer the forwarder calls. */
      settlerAddress: z.string(),
      chainSelectorName: z.string(),
      gasLimit: z.string(),
    }),
  ),
});

type Config = z.infer<typeof configSchema>;

/** Read a contract view at the last finalized block via the CRE EVM client, returning the raw bytes. */
const readContract = (
  runtime: Runtime<Config>,
  evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
  to: Address,
  data: `0x${string}`,
): `0x${string}` => {
  const reply = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to, data }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  return bytesToHex(reply.data);
};

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const evm = runtime.config.evms[0];
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evm.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`unknown chain ${evm.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const marketId = runtime.config.marketId as `0x${string}`;

  // 1a. Read the verified mark on-chain (delivered by the mark-feed workflow).
  const mark = decodeFunctionResult({
    abi: ORACLE_GETMARK_ABI,
    functionName: "getMark",
    data: readContract(
      runtime,
      evmClient,
      evm.markReceiverAddress as Address,
      encodeFunctionData({ abi: ORACLE_GETMARK_ABI, functionName: "getMark" }),
    ),
  }) as { price18: bigint; timestampMs: bigint };
  const markPrice = mark.price18 > 0n ? mark.price18 : 0n;
  if (markPrice === 0n) throw new Error("mark is zero/stale — run the mark-feed workflow first");

  // 1b. Read the open-account set on-chain (decentralized — no off-chain list).
  const accounts = decodeFunctionResult({
    abi: PERP_ENGINE_READ_ABI,
    functionName: "openAccounts",
    data: readContract(
      runtime,
      evmClient,
      evm.perpEngineAddress as Address,
      encodeFunctionData({
        abi: PERP_ENGINE_READ_ABI,
        functionName: "openAccounts",
        args: [marketId],
      }),
    ),
  }) as readonly Address[];

  runtime.log(
    `settling ${marketId} at mark ${markPrice.toString()} over ${accounts.length} account(s)`,
  );
  if (accounts.length === 0) {
    runtime.log("no open accounts — nothing to settle this cycle");
    return "no-op";
  }

  // 2. Build the SettleReport, reach consensus, and write it through the forwarder to the settler.
  const reportPayload = encodeAbiParameters(
    [{ type: "tuple", components: SETTLE_REPORT_COMPONENTS as never }],
    [{ marketId, mark: markPrice, accounts: [...accounts] }] as never,
  );
  const report = runtime.report(prepareReportRequest(reportPayload)).result();
  const resp = evmClient
    .writeReport(runtime, {
      receiver: evm.settlerAddress as Address,
      report,
      gasConfig: { gasLimit: evm.gasLimit },
    })
    .result();

  if (resp.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`settle write failed: ${resp.errorMessage || resp.txStatus}`);
  }
  const txHash = bytesToHex(resp.txHash || new Uint8Array(32));
  runtime.log(`✓ CRE-driven checkpoint written on-chain: ${txHash}`);
  return txHash;
};

export const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};
