/**
 * add-market-deploy — add a brand-new market to the LIVE venue on Arc (no full redeploy). The venue's
 * Vault / PerpEngine / MarketRegistry are shared; a new market just needs its own Pool + LPToken +
 * oracle adapter, then `MarketRegistry.registerMarket`. This script does the whole sequence for a
 * **Stork** market (the analog of markreceiver-deploy.ts, which repoints an existing market to Chainlink).
 *
 *   1. Pool(marketId, vault, owner)
 *   2. LPToken("SideKick <SYM> LP", "slpUSDC-<BASE>", pool)
 *   3. pool.setLpToken(lp)  ·  pool.setEngine(engine)  ·  vault.setOperator(pool, true)   (owner-gated wiring)
 *   4. StorkAdapter(STORK, keccak256(asset))   — the per-market IOracleAdapter
 *   5. registry.registerMarket(marketId, symbol, params, pool, adapter, feedId)
 *
 * After this, add the printed addresses to packages/shared/src/deployments.ts, set the engine's MARKETS
 * + ORACLE_SOURCE_<SYM>=stork, push a mark (stork-push.ts or the engine's pre-checkpoint push), seed the
 * pool, and trade.
 *
 * Run: `bun run src/scripts/add-market-deploy.ts --symbol XAU-PERP --asset XAUUSD --name Gold`
 * Requires a funded PRIVATE_KEY that is the registry/venue owner (the deploy EOA).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARC_TESTNET_DEPLOYMENT,
  type MarketSymbol,
  marketId as marketIdOf,
  storkAssetId,
} from "@sidekick/shared";
import { type Abi, type Address, type Hex, keccak256, toBytes } from "viem";
import { operatorAccount, operatorWallet, publicClient } from "../chain/clients.ts";

loadRootEnv();

/** The Stork contract on Arc testnet (same address Deploy.s.sol uses). */
const STORK = "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62" as Address;

/** The swept on-chain params (WAD), mirroring src/generated/Params.sol — every market shares these. */
const PARAMS = {
  m: 10_000_000_000_000_000n, // 0.01
  alpha: 500_000_000_000_000n, // 0.0005
  lambda: 80_000_000_000_000_000n, // 0.08
  rMax: 500_000_000_000_000n, // 0.0005
  k: 3n,
} as const;

const REGISTER_MARKET_ABI = [
  {
    type: "function",
    name: "registerMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "symbol", type: "string" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "m", type: "int256" },
          { name: "alpha", type: "int256" },
          { name: "lambda", type: "int256" },
          { name: "rMax", type: "int256" },
          { name: "k", type: "uint256" },
        ],
      },
      { name: "pool", type: "address" },
      { name: "oracleAdapter", type: "address" },
      { name: "feedId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const POOL_WIRE_ABI = [
  {
    type: "function",
    name: "setLpToken",
    stateMutability: "nonpayable",
    inputs: [{ name: "lpToken_", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setEngine",
    stateMutability: "nonpayable",
    inputs: [{ name: "engine_", type: "address" }],
    outputs: [],
  },
] as const;

const VAULT_SET_OPERATOR_ABI = [
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
] as const;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

function loadArtifact(relPath: string): { abi: Abi; bytecode: { object: Hex } } {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../contracts/out/${relPath}`, import.meta.url)), "utf8"),
  );
}

async function main(): Promise<void> {
  const symbol = arg("symbol", "XAU-PERP") as MarketSymbol;
  const asset = arg("asset", "XAUUSD");
  const name = arg("name", "Gold");
  const base = symbol.split("-")[0]; // "XAU"

  const pub = publicClient();
  const wallet = operatorWallet();
  const owner = operatorAccount().address;
  const { vault, perpEngine: engine, marketRegistry: registry } = ARC_TESTNET_DEPLOYMENT;
  const mId = marketIdOf(symbol);
  // Stork feed id = keccak256(utf8(asset)). storkAssetId does exactly this; keep the toBytes form as a
  // cross-check that they agree.
  const feedId = storkAssetId(asset);
  if (feedId !== keccak256(toBytes(asset))) throw new Error("feed id derivation mismatch");

  console.log(`── Add market ${symbol} (${name} / ${asset}) — Stork ──`);
  console.log(`  owner/deployer: ${owner}`);
  console.log(`  marketId:       ${mId}`);
  console.log(`  feedId:         ${feedId}`);
  console.log(`  vault/engine/registry: ${vault} / ${engine} / ${registry}\n`);

  const wire = async (
    to: Address,
    abi: Abi,
    functionName: string,
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous arg tuples per call.
    args: any[],
    label: string,
  ): Promise<void> => {
    const h = await wallet.writeContract({ address: to, abi, functionName, args, chain: wallet.chain, account: wallet.account });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  ✓ ${label} (tx ${h})`);
  };

  // 1. Pool
  const poolArt = loadArtifact("Pool.sol/Pool.json");
  console.log("  deploying Pool…");
  const poolHash = await wallet.deployContract({
    abi: poolArt.abi,
    bytecode: poolArt.bytecode.object,
    args: [mId, vault, owner],
    chain: wallet.chain,
    account: wallet.account,
  });
  const pool = (await pub.waitForTransactionReceipt({ hash: poolHash })).contractAddress as Address;
  console.log(`  ✓ Pool @ ${pool} (tx ${poolHash})`);

  // 2. LPToken
  const lpArt = loadArtifact("LPToken.sol/LPToken.json");
  console.log("  deploying LPToken…");
  const lpHash = await wallet.deployContract({
    abi: lpArt.abi,
    bytecode: lpArt.bytecode.object,
    args: [`SideKick ${symbol} LP`, `slpUSDC-${base}`, pool],
    chain: wallet.chain,
    account: wallet.account,
  });
  const lpToken = (await pub.waitForTransactionReceipt({ hash: lpHash })).contractAddress as Address;
  console.log(`  ✓ LPToken @ ${lpToken} (tx ${lpHash})`);

  // 3. Wiring (owner-gated)
  await wire(pool, POOL_WIRE_ABI as unknown as Abi, "setLpToken", [lpToken], "pool.setLpToken");
  await wire(pool, POOL_WIRE_ABI as unknown as Abi, "setEngine", [engine], "pool.setEngine");
  await wire(vault, VAULT_SET_OPERATOR_ABI as unknown as Abi, "setOperator", [pool, true], "vault.setOperator(pool, true)");

  // 4. StorkAdapter
  const adapterArt = loadArtifact("StorkAdapter.sol/StorkAdapter.json");
  console.log("  deploying StorkAdapter…");
  const adapterHash = await wallet.deployContract({
    abi: adapterArt.abi,
    bytecode: adapterArt.bytecode.object,
    args: [STORK, feedId],
    chain: wallet.chain,
    account: wallet.account,
  });
  const adapter = (await pub.waitForTransactionReceipt({ hash: adapterHash })).contractAddress as Address;
  console.log(`  ✓ StorkAdapter @ ${adapter} (tx ${adapterHash})`);

  // 5. Register
  await wire(
    registry,
    REGISTER_MARKET_ABI as unknown as Abi,
    "registerMarket",
    [mId, symbol, PARAMS, pool, adapter, feedId],
    `registry.registerMarket(${symbol})`,
  );

  console.log(`\n✅ ${symbol} added. Add to packages/shared/src/deployments.ts markets:`);
  console.log(`    "${symbol}": {`);
  console.log(`      pool: "${pool}" as Address,`);
  console.log(`      lpToken: "${lpToken}" as Address,`);
  console.log(`      oracleAdapter: "${adapter}" as Address,`);
  console.log(`    },`);
  console.log(
    `\nThen: set MARKETS to include ${symbol}, ORACLE_SOURCE_${symbol.replace(/-/g, "")}=stork, push a mark, seed the pool.`,
  );
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
      if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")))
        v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ambient env */
  }
}

main().catch((err) => {
  console.error("add-market-deploy failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
