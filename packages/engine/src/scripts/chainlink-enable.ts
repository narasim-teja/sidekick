/**
 * chainlink-enable — stand up a NATIVE on-chain Chainlink leg for one market, end to end:
 *
 *   1. Deploy a fresh `ChainlinkAdapter` (relay mode — the Arc Data Streams Verifier is unconfirmed,
 *      so verifier=address(0); the owner seeds marks via `pushMarkUnverified`).
 *   2. Pull a REAL live price from the Data Streams REST API (HMAC auth, your CHAINLINK_API_KEY/SECRET)
 *      and seed it into the adapter on-chain, so `getMark()` returns a genuine Chainlink price.
 *   3. Repoint the market's oracle in the on-chain `MarketRegistry.setOracle(...)` to the new adapter.
 *
 * After this lands, set the printed adapter address in `deployments.ts` for the market, then run the
 * engine with `ORACLE_SOURCE_<MARKET>=chainlink` — the boot-time `assertAdapterSource` guard passes
 * (the adapter reports "chainlink") and the loop reads a real Chainlink mark with provenance
 * `chainlink-live`.
 *
 * Run: `bun run src/scripts/chainlink-enable.ts [--market LINK-PERP] [--feed-symbol LINK/USD]`
 * Requires a funded PRIVATE_KEY (the registry owner / deploy EOA) + CHAINLINK_API_KEY/SECRET.
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARC_TESTNET_DEPLOYMENT,
  type MarketSymbol,
  marketId as marketIdOf,
} from "@sidekick/shared";
import { type Address, decodeAbiParameters, getContract, type Hex } from "viem";
import { operatorAccount, operatorWallet, publicClient } from "../chain/clients.ts";
import { ORACLE_ADAPTER_ABI } from "../chain/abis.ts";

loadRootEnv();

// Chainlink's own 32-byte Data Streams testnet feed ids (the venue's CHAINLINK_FEED_<SYM> value).
const FEED_IDS: Record<string, Hex> = {
  "LINK/USD": "0x00036fe43f87884450b4c7e093cd5ed99cac6640d8c2000e6afc02c8838d0265",
  "ETH/USD": "0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782",
  "BTC/USD": "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8",
};

const DATASTREAMS_HOST = "api.testnet-dataengine.chain.link";
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
const ADAPTER_SEED_ABI = [
  {
    type: "function",
    name: "pushMarkUnverified",
    stateMutability: "nonpayable",
    inputs: [
      { name: "price18", type: "int256" },
      { name: "timestampMs", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

const REPORT_V3_SCHEMA = [
  { type: "bytes32" },
  { type: "uint32" },
  { type: "uint32" },
  { type: "uint192" },
  { type: "uint192" },
  { type: "uint32" },
  { type: "int192" }, // price (index 6)
  { type: "int192" },
  { type: "int192" },
] as const;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

/** Pull a live Data Streams price (price18 WAD) + observation time (ms) for a feed id. */
async function fetchLivePrice(feedId: Hex): Promise<{ price18: bigint; observedMs: number }> {
  const apiKey = process.env.CHAINLINK_API_KEY;
  const apiSecret = process.env.CHAINLINK_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("CHAINLINK_API_KEY and CHAINLINK_API_SECRET required");
  const host = process.env.CHAINLINK_STREAMS_HOST || DATASTREAMS_HOST;
  const path = `/api/v1/reports/latest?feedID=${feedId}`;
  const ts = Date.now();
  const bodyHash = createHash("sha256").update("").digest("hex");
  const sig = createHmac("sha256", apiSecret)
    .update(`GET ${path} ${bodyHash} ${apiKey} ${ts}`)
    .digest("hex");
  const res = await fetch(`https://${host}${path}`, {
    headers: {
      Authorization: apiKey,
      "X-Authorization-Timestamp": String(ts),
      "X-Authorization-Signature-SHA256": sig,
    },
  });
  if (!res.ok) throw new Error(`Data Streams ${res.status}: ${await res.text().catch(() => "")}`);
  const { report } = (await res.json()) as { report: { fullReport: Hex } };
  const [, blob] = decodeAbiParameters(
    [
      { type: "bytes32[3]" },
      { type: "bytes" },
      { type: "bytes32[]" },
      { type: "bytes32[]" },
      { type: "bytes32" },
    ],
    report.fullReport,
  );
  const decoded = decodeAbiParameters(REPORT_V3_SCHEMA, blob as Hex);
  return { price18: decoded[6] as bigint, observedMs: Number(decoded[2]) * 1000 };
}

async function main(): Promise<void> {
  const market = arg("market", "LINK-PERP") as MarketSymbol;
  const feedSymbol = arg("feed-symbol", "LINK/USD");
  const feedId = (process.env[`CHAINLINK_FEED_${market.replace(/-/g, "")}`] as Hex) || FEED_IDS[feedSymbol];
  if (!feedId) throw new Error(`no feed id for ${market} / ${feedSymbol}`);

  const pub = publicClient();
  const wallet = operatorWallet();
  const owner = operatorAccount().address;
  const registry = ARC_TESTNET_DEPLOYMENT.marketRegistry;
  const verifier = (process.env.CHAINLINK_VERIFIER as Address) || "0x0000000000000000000000000000000000000000";
  const feeToken = (process.env.CHAINLINK_FEE_TOKEN as Address) || "0x0000000000000000000000000000000000000000";

  console.log(`── Enable native Chainlink leg for ${market} (${feedSymbol}) ──`);
  console.log(`  owner/deployer: ${owner}`);
  console.log(`  registry:       ${registry}`);
  console.log(`  feedId:         ${feedId}`);
  console.log(`  verifier:       ${verifier === "0x0000000000000000000000000000000000000000" ? "address(0) → RELAY MODE" : verifier}\n`);

  // 1. Pull the live price BEFORE deploying, so we fail fast on bad creds.
  console.log("  fetching live Data Streams price…");
  const { price18, observedMs } = await fetchLivePrice(feedId);
  console.log(`  ✓ live ${feedSymbol} = $${(Number(price18) / 1e18).toLocaleString()} (observed ${Math.round((Date.now() - observedMs) / 1000)}s ago)\n`);

  // 2. Deploy the ChainlinkAdapter from the compiled artifact.
  const artifact = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../contracts/out/ChainlinkAdapter.sol/ChainlinkAdapter.json", import.meta.url)),
      "utf8",
    ),
  );
  console.log("  deploying ChainlinkAdapter…");
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [verifier, feedId, feeToken, owner],
    chain: wallet.chain,
    account: wallet.account,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const adapter = rcpt.contractAddress as Address;
  console.log(`  ✓ ChainlinkAdapter @ ${adapter} (tx ${deployHash})\n`);

  // 3. Seed the live mark on-chain (relay mode).
  console.log("  seeding the live mark on-chain (pushMarkUnverified)…");
  const seedHash = await wallet.writeContract({
    address: adapter,
    abi: ADAPTER_SEED_ABI,
    functionName: "pushMarkUnverified",
    args: [price18, BigInt(observedMs)],
    chain: wallet.chain,
    account: wallet.account,
  });
  await pub.waitForTransactionReceipt({ hash: seedHash });
  // Read it back through the same getMark() the engine uses.
  const mark = (await pub.readContract({ address: adapter, abi: ORACLE_ADAPTER_ABI, functionName: "getMark" })) as {
    price18: bigint;
    timestampMs: bigint;
  };
  const src = await pub.readContract({ address: adapter, abi: ORACLE_ADAPTER_ABI, functionName: "source" });
  console.log(`  ✓ getMark() → $${(Number(mark.price18) / 1e18).toLocaleString()}  source()="${src}"\n`);

  // 4. Repoint the registry so the market's oracle is now this adapter.
  console.log("  repointing the registry (setOracle)…");
  const setHash = await wallet.writeContract({
    address: registry,
    abi: REGISTRY_SET_ORACLE_ABI,
    functionName: "setOracle",
    args: [marketIdOf(market), adapter, feedId],
    chain: wallet.chain,
    account: wallet.account,
  });
  await pub.waitForTransactionReceipt({ hash: setHash });
  console.log(`  ✓ ${market} oracle repointed → ${adapter} (tx ${setHash})\n`);

  console.log("✅ Chainlink leg enabled on-chain. Next:");
  console.log(`   1. Set ${market} oracleAdapter in packages/shared/src/deployments.ts to:`);
  console.log(`        ${adapter}`);
  console.log(`   2. Run the engine with: MARKETS=${market} ORACLE_SOURCE_${market.replace(/-/g, "")}=chainlink`);
  console.log(`   (the mark is relay-seeded; re-run this script or wire a refresh to keep it fresh)`);
  // Keep getContract imported for any follow-up tooling.
  void getContract;
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
      if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ambient env */
  }
}

main().catch((err) => {
  console.error("chainlink-enable failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
