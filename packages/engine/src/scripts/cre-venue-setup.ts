/**
 * cre-venue-setup — give the isolated CRE-settled venue something to settle: seed its pool and open
 * one position, so the settlement workflow has a live account to checkpoint.
 *
 * Uses the deployer (PRIVATE_KEY) as both the LP and the trader (a one-account demo is enough to show
 * CRE driving a real checkpoint — funding/margin move on it). Addresses come from CLI flags so this
 * stays decoupled from any hard-coded deployment.
 *
 * Run: bun run src/scripts/cre-venue-setup.ts \
 *        --vault 0x.. --pool 0x.. --engine 0x.. --usdc 0x3600..0000 \
 *        --mark <price18> [--capital 50] [--gap 5] [--notional 20] [--margin 5]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { marketId as marketIdOf } from "@sidekick/shared";
import { type Address, erc20Abi, type Hex, parseUnits } from "viem";
import { operatorAccount, operatorWallet, publicClient } from "../chain/clients.ts";

loadRootEnv();

const VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "freeCollateral",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const POOL_ABI = [
  {
    type: "function",
    name: "provideLiquidity",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "seedGapFund",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;
const ENGINE_ABI = [
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
  {
    type: "function",
    name: "openAccounts",
    stateMutability: "view",
    inputs: [{ name: "m", type: "bytes32" }],
    outputs: [{ type: "address[]" }],
  },
] as const;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  if (v === undefined || v.startsWith("--")) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return v;
}

const USDC = (n: string) => parseUnits(n, 6);

async function main(): Promise<void> {
  const usdc = arg("usdc", "0x3600000000000000000000000000000000000000") as Address;
  const vault = arg("vault") as Address;
  const pool = arg("pool") as Address;
  const engine = arg("engine") as Address;
  const mark = BigInt(arg("mark")); // price18 (e.g. 8e18 for $8)
  const market = arg("market", "LINK-PERP");
  const mId = marketIdOf(market as "LINK-PERP");

  const capital = USDC(arg("capital", "50"));
  const gap = USDC(arg("gap", "5"));
  const notional = USDC(arg("notional", "20"));
  const margin = USDC(arg("margin", "5"));

  const pub = publicClient();
  const wallet = operatorWallet();
  const me = operatorAccount().address;

  const send = async (
    address: Address,
    abi: unknown,
    fn: string,
    args: unknown[],
  ): Promise<Hex> => {
    const hash = await wallet.writeContract({
      address,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ad-hoc ABIs for one-off setup
      abi: abi as any,
      functionName: fn,
      args,
      chain: wallet.chain,
      account: wallet.account,
    });
    if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") {
      throw new Error(`${fn} reverted (${hash})`);
    }
    return hash;
  };

  console.log(`── CRE venue setup (${market}) ──`);
  console.log(`  account: ${me}  mark: ${mark.toString()} (price18)\n`);

  // Approve + deposit enough USDC into the Vault to cover LP capital + gap + position margin.
  const total = capital + gap + margin;
  await send(usdc, erc20Abi, "approve", [vault, total]);
  await send(vault, VAULT_ABI, "deposit", [total]);
  console.log(`  ✓ deposited ${total} atomic USDC into the Vault`);

  // Seed the pool (LP capital + gap fund).
  await send(pool, POOL_ABI, "provideLiquidity", [capital]);
  await send(pool, POOL_ABI, "seedGapFund", [gap]);
  console.log(`  ✓ pool seeded: capital ${capital}, gap ${gap}`);

  // Open one long position (side 1 = Long).
  await send(engine, ENGINE_ABI, "openPosition", [mId, 1, notional, margin, mark]);
  console.log(`  ✓ opened long: notional ${notional}, margin ${margin}`);

  const open = (await pub.readContract({
    address: engine,
    abi: ENGINE_ABI,
    functionName: "openAccounts",
    args: [mId],
  })) as Address[];
  console.log(`\n✅ open accounts on-chain: ${open.length} → ${open.join(", ")}`);
  console.log(
    "   run the settle workflow next: cre workflow simulate ./settle --broadcast --target arc",
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
  console.error("cre-venue-setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
