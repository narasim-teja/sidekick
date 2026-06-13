/**
 * live:open — seed a market's pool (if thin) and open a position against the live Arc venue, so the
 * engine loop has something to reconcile. Encapsulates the operational order the venue requires:
 *
 *   1. approve + deposit USDC into the Vault (free collateral),
 *   2. provideLiquidity to the market's Pool — REQUIRED before any trader can open, because the
 *      Layer-2 OI cap is k·capital and a 0-capital pool admits nothing (reverts OICapExceeded),
 *   3. openPosition at the live mark.
 *
 * Run: `bun run live:open -- --market BTC-PERP --side long --notional 2 --margin 1 --seed 3`
 * (all amounts in USDC; `--seed` is the pool liquidity to provide, skipped if the pool is funded.)
 *
 * Uses the operator key for everything (POC: the operator is also a trader/LP here). Requires a
 * funded `PRIVATE_KEY` with USDC (faucet: https://faucet.circle.com).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARC_TESTNET_DEPLOYMENT,
  getMarket,
  type MarketSymbol,
  marketDeployment,
} from "@sidekick/shared";
import { erc20Abi } from "viem";
import { VAULT_ABI } from "../chain/abis.ts";
import { operatorAccount, operatorWallet, publicClient } from "../chain/clients.ts";
import { Venue } from "../chain/venue.ts";
import { formatUsdc, formatWad, parseUsdc } from "../fixed/units.ts";
import { makeOracle } from "../oracle/index.ts";

loadRootEnv();

function loadRootEnv(): void {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../../.env", import.meta.url)), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim();
    }
  } catch {
    /* ambient env */
  }
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1] as string;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main(): Promise<void> {
  const market = arg("market", "BTC-PERP") as MarketSymbol;
  const side = arg("side", "long") as "long" | "short";
  const notional = parseUsdc(arg("notional", "2"));
  const margin = parseUsdc(arg("margin", "1"));
  const seed = parseUsdc(arg("seed", "3"));

  const pub = publicClient();
  const wallet = operatorWallet();
  const account = operatorAccount().address;
  const venue = new Venue(pub, wallet);
  const md = marketDeployment(ARC_TESTNET_DEPLOYMENT, market);
  const usdc = ARC_TESTNET_DEPLOYMENT.usdc;
  const vault = ARC_TESTNET_DEPLOYMENT.vault;

  // Live mark for the open.
  const oracle = makeOracle(pub, getMarket(market), md.oracleAdapter);
  const mark = (await oracle.getMark()).price18;
  console.log(`market ${market} @ $${formatWad(mark)} (mark for open)`);

  // Ensure enough free collateral: deposit (seed + margin) if short.
  const need = seed + margin;
  const free = await venue.freeCollateral(account);
  if (free < need) {
    const top = need - free;
    console.log(`depositing ${formatUsdc(top)} USDC into the Vault…`);
    const allowance = (await pub.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, vault],
    })) as bigint;
    if (allowance < top) {
      const ah = await wallet.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [vault, top],
        chain: wallet.chain,
        account: wallet.account,
      });
      await pub.waitForTransactionReceipt({ hash: ah });
    }
    const dh = await wallet.writeContract({
      address: vault,
      abi: VAULT_ABI_WRITE,
      functionName: "deposit",
      args: [top],
      chain: wallet.chain,
      account: wallet.account,
    });
    await pub.waitForTransactionReceipt({ hash: dh });
  }

  // Seed the pool if thin (the OI cap needs capital before an open is admitted).
  const capital = (await pub.readContract({
    address: md.pool,
    abi: POOL_ABI,
    functionName: "capital",
  })) as bigint;
  if (capital < seed) {
    console.log(`seeding pool with ${formatUsdc(seed)} USDC of liquidity…`);
    const sh = await wallet.writeContract({
      address: md.pool,
      abi: POOL_ABI,
      functionName: "provideLiquidity",
      args: [seed],
      chain: wallet.chain,
      account: wallet.account,
    });
    await pub.waitForTransactionReceipt({ hash: sh });
  }

  // Open the position.
  console.log(
    `opening ${side} ${market}: notional $${formatUsdc(notional)}, margin $${formatUsdc(margin)}…`,
  );
  const oh = await wallet.writeContract({
    address: ARC_TESTNET_DEPLOYMENT.perpEngine,
    abi: OPEN_ABI,
    functionName: "openPosition",
    args: [venue.marketId(market), side === "long" ? 1 : 2, notional, margin, mark],
    chain: wallet.chain,
    account: wallet.account,
  });
  const ok = (await pub.waitForTransactionReceipt({ hash: oh })).status === "success";
  console.log(ok ? `✓ opened (${oh})` : `✗ open reverted (${oh})`);
  const pos = await venue.positionOf(market, account);
  console.log("position:", pos);
  process.exit(ok ? 0 : 1);
}

// Minimal write ABIs (the read ABIs live in chain/abis.ts; these add the few writes the script needs).
const VAULT_ABI_WRITE = [
  ...VAULT_ABI,
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

const OPEN_ABI = [
  {
    type: "function",
    name: "openPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "side", type: "uint8" },
      { name: "notional", type: "uint256" },
      { name: "margin", type: "uint256" },
      { name: "mark", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// Pool: read capital + provide liquidity (the seed step the OI cap requires).
const POOL_ABI = [
  {
    type: "function",
    name: "capital",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "provideLiquidity",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

main().catch((err) => {
  console.error("live:open failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
