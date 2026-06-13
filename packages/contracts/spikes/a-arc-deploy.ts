/**
 * Spike A — Arc deploy + USDC gas + WSS read-back.
 *
 * Deploys the trivial `Ping` contract to Arc testnet (paying gas in USDC from the faucet),
 * subscribes to its event over WSS, sends a `ping()` tx, and confirms the event fires and the
 * stored value reads back. Confirms: Foundry/viem work unmodified, the USDC-gas flow, and that
 * WSS subscriptions fire per-block.
 *
 * Run: `bun run spike:arc` (from repo root) — requires a funded PRIVATE_KEY in .env.
 *
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 0 Spike A
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARC } from "@sidekick/shared";
import { type Abi, formatGwei, formatUnits, parseAbiItem } from "viem";
import {
  banner,
  httpClient,
  loadRootEnv,
  REPO_ROOT,
  spikeAccount,
  walletClient,
  wssClient,
} from "./_shared.ts";

loadRootEnv();

type Artifact = { abi: Abi; bytecode: { object: `0x${string}` } };

function loadPing(): Artifact {
  const path = resolve(REPO_ROOT, "packages/contracts/out/Ping.sol/Ping.json");
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

async function main() {
  banner("Spike A — Arc deploy + USDC gas + WSS read-back");

  const account = spikeAccount();
  const pub = httpClient();
  const wallet = walletClient(account);
  const { abi, bytecode } = loadPing();

  // 1. Sanity: chain id + balance (gas is USDC, 18 decimals on Arc).
  const chainId = await pub.getChainId();
  const balance = await pub.getBalance({ address: account.address });
  console.log(`account:  ${account.address}`);
  console.log(`chainId:  ${chainId} (expected ${ARC.chainId})`);
  console.log(
    `balance:  ${formatUnits(balance, ARC.nativeCurrency.decimals)} ${ARC.nativeCurrency.symbol} (gas token)`,
  );
  if (chainId !== ARC.chainId) throw new Error(`Wrong chain: ${chainId} != ${ARC.chainId}`);
  if (balance === 0n) throw new Error("Account has 0 USDC — fund it at https://faucet.circle.com");

  // 2. Subscribe over WSS to the Pinged event BEFORE we send, to prove per-block push.
  const wss = wssClient();
  const pingedEvent = parseAbiItem(
    "event Pinged(address indexed from, uint256 value, uint256 blockNumber)",
  );
  let eventSeen = false;
  const unwatch = wss.watchEvent({
    event: pingedEvent,
    onLogs: (logs) => {
      for (const log of logs) {
        eventSeen = true;
        const { value, blockNumber } = log.args;
        console.log(`[wss] Pinged: value=${value} block=${blockNumber} tx=${log.transactionHash}`);
      }
    },
  });

  // 3. Deploy Ping (pays gas in USDC).
  const deployHash = await wallet.deployContract({
    abi,
    bytecode: bytecode.object,
    account,
    chain: null,
  });
  console.log(`\ndeploy tx: ${deployHash}`);
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const address = deployRcpt.contractAddress;
  if (!address) throw new Error("Deploy produced no contract address");
  const gasCost = deployRcpt.gasUsed * (deployRcpt.effectiveGasPrice ?? 0n);
  console.log(`deployed:  ${address}  (${ARC.explorerUrl}/address/${address})`);
  console.log(
    `gas used:  ${deployRcpt.gasUsed} @ ${formatGwei(deployRcpt.effectiveGasPrice ?? 0n)} gwei = ${formatUnits(gasCost, ARC.nativeCurrency.decimals)} USDC`,
  );

  // 4. Send a ping() and wait for it.
  const value = 42n;
  const pingHash = await wallet.writeContract({
    address,
    abi,
    functionName: "ping",
    args: [value],
    account,
    chain: null,
  });
  console.log(`\nping tx:   ${pingHash}`);
  await pub.waitForTransactionReceipt({ hash: pingHash });

  // 5. Read the value back over HTTP.
  const readBack = (await pub.readContract({ address, abi, functionName: "value" })) as bigint;
  console.log(`read back: value() = ${readBack} (expected ${value})`);
  if (readBack !== value) throw new Error(`Read-back mismatch: ${readBack} != ${value}`);

  // 6. Give the WSS event a moment to arrive, then report and tear down the socket.
  await new Promise((r) => setTimeout(r, 4000));
  unwatch();
  console.log(
    `\nWSS event received: ${eventSeen ? "YES" : "NO (subscription did not fire in time)"}`,
  );

  banner(eventSeen && readBack === value ? "Spike A PASS ✓" : "Spike A INCOMPLETE — see above");
  if (!eventSeen) {
    console.log("Note: deploy + USDC-gas + read-back all worked; only the live WSS push did not");
    console.log("arrive in the wait window. Re-run, or lengthen the wait, to confirm the WSS leg.");
  }

  // The WSS transport holds the event loop open; close it so the process exits cleanly.
  const rpc = await wss.transport.getRpcClient();
  rpc.close();
  process.exit(eventSeen && readBack === value ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSpike A FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
