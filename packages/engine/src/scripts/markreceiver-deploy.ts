/**
 * markreceiver-deploy — deploy the CRE consumer {MarkReceiver} on Arc and repoint a market's oracle
 * to it, so the Chainlink CRE workflow's on-chain write (forwarder → onReport) drives the venue mark.
 *
 *   1. Deploy MarkReceiver(arcForwarder, feedId, owner) — gated so ONLY the Arc KeystoneForwarder
 *      can write the mark (the qualifying Chainlink state change).
 *   2. Repoint the market's oracle in the on-chain MarketRegistry to the new MarkReceiver.
 *
 * After this, run the CRE workflow (`cre workflow simulate ./markfeed --broadcast`) to have the DON
 * deliver a Data Streams price into MarkReceiver.onReport; the engine then reads it (chainlink-live).
 * NOTE: getMark() reverts StaleMark until the first report lands — that's expected (the engine falls
 * back to synthetic until the CRE workflow writes), so deploy → run workflow → then run the engine.
 *
 * Run: `bun run src/scripts/markreceiver-deploy.ts [--market LINK-PERP] [--feed-symbol LINK/USD]`
 * Requires a funded PRIVATE_KEY (registry owner / deploy EOA).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARC_TESTNET_DEPLOYMENT,
  CHAINLINK,
  type MarketSymbol,
  marketId as marketIdOf,
} from "@sidekick/shared";
import type { Address, Hex } from "viem";
import { operatorAccount, operatorWallet, publicClient } from "../chain/clients.ts";

loadRootEnv();

const FEED_IDS: Record<string, Hex> = {
  "LINK/USD": "0x00036fe43f87884450b4c7e093cd5ed99cac6640d8c2000e6afc02c8838d0265",
  "ETH/USD": "0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782",
  "BTC/USD": "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8",
};

const REGISTRY_SET_ORACLE_ABI = [
  {
    type: "function",
    name: "setOracle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "oracleAdapter", type: "address" },
      { name: "feedId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const market = arg("market", "LINK-PERP") as MarketSymbol;
  const feedSymbol = arg("feed-symbol", "LINK/USD");
  const feedId =
    (process.env[`CHAINLINK_FEED_${market.replace(/-/g, "")}`] as Hex) || FEED_IDS[feedSymbol];
  if (!feedId) throw new Error(`no feed id for ${market} / ${feedSymbol}`);

  const pub = publicClient();
  const wallet = operatorWallet();
  const owner = operatorAccount().address;
  // Authorized forwarders: the production Arc KeystoneForwarder, plus (optionally) the local CRE
  // simulator forwarder so `cre workflow simulate --broadcast` lands a real mark during the demo.
  // The simulator forwarder is stable; override via CRE_SIM_FORWARDER if a CLI update changes it.
  const simForwarder = (process.env.CRE_SIM_FORWARDER ||
    "0x6e9ee680ef59ef64aa8c7371279c27e496b5edc1") as Address;
  const forwarders = [CHAINLINK.arcForwarder, simForwarder];
  const registry = ARC_TESTNET_DEPLOYMENT.marketRegistry;

  console.log(`── Deploy MarkReceiver (CRE consumer) for ${market} ──`);
  console.log(`  owner/deployer: ${owner}`);
  console.log(`  forwarders:     ${forwarders.join(", ")}`);
  console.log(`                  (Arc KeystoneForwarder + CRE simulator forwarder)`);
  console.log(`  feedId:         ${feedId}`);
  console.log(`  registry:       ${registry}\n`);

  const artifact = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../contracts/out/MarkReceiver.sol/MarkReceiver.json", import.meta.url),
      ),
      "utf8",
    ),
  );

  console.log("  deploying MarkReceiver…");
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [forwarders, feedId, owner],
    chain: wallet.chain,
    account: wallet.account,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const receiver = rcpt.contractAddress as Address;
  console.log(`  ✓ MarkReceiver @ ${receiver} (tx ${deployHash})\n`);

  console.log("  repointing the registry (setOracle) → MarkReceiver…");
  const setHash = await wallet.writeContract({
    address: registry,
    abi: REGISTRY_SET_ORACLE_ABI,
    functionName: "setOracle",
    args: [marketIdOf(market), receiver, feedId],
    chain: wallet.chain,
    account: wallet.account,
  });
  await pub.waitForTransactionReceipt({ hash: setHash });
  console.log(`  ✓ ${market} oracle repointed → ${receiver} (tx ${setHash})\n`);

  console.log("✅ MarkReceiver deployed + wired. Next:");
  console.log(`   1. Set ${market} oracleAdapter in packages/shared/src/deployments.ts to:`);
  console.log(`        ${receiver}`);
  console.log(`   2. Set markReceiverAddress in packages/cre/markfeed/config.json to the same.`);
  console.log(`   3. Run the CRE workflow to deliver a mark:`);
  console.log(
    `        cd packages/cre && cre workflow simulate ./markfeed --broadcast --target arc`,
  );
  console.log(
    `   4. Then run the engine: MARKETS=${market} ORACLE_SOURCE_${market.replace(/-/g, "")}=chainlink \\`,
  );
  console.log(`        CHAINLINK_FEED_${market.replace(/-/g, "")}=${feedId} bun run engine`);
  process.exit(0);
}

function loadRootEnv(): void {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../../.env", import.meta.url)), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        v.length >= 2 &&
        ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))
      )
        v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ambient env */
  }
}

main().catch((err) => {
  console.error("markreceiver-deploy failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
