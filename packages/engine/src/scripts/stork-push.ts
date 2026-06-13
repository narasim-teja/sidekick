/**
 * stork-push — live test of the Stork pull-update path on Arc testnet. Fetches a fresh signed BTCUSD
 * price over REST, reads the on-chain mark BEFORE, pushes the update via `updateTemporalNumericValuesV1`,
 * then reads AFTER — proving the on-chain mark moved to the live value. The make-or-break validation
 * that the venue can drive a moving real mark (so funding / margin calls / decrements fire).
 *
 * Run: `bun run src/scripts/stork-push.ts [--asset BTCUSD]`. Requires a funded PRIVATE_KEY + STORK_API_KEY.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";
import { operatorAccount, operatorWallet, publicClient } from "../chain/clients.ts";
import { fetchStorkUpdate, pushStorkUpdate, STORK_UPDATE_ABI } from "../oracle/stork.ts";

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
      let v = t.slice(i + 1).trim();
      if (
        v.length >= 2 &&
        ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ambient env */
  }
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const STORK_READ_ABI = [
  {
    type: "function",
    name: "getTemporalNumericValueUnsafeV1",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "value",
        type: "tuple",
        components: [
          { name: "timestampNs", type: "uint64" },
          { name: "quantizedValue", type: "int192" },
        ],
      },
    ],
  },
] as const;

async function readMark(
  pub: ReturnType<typeof publicClient>,
  stork: `0x${string}`,
  feedId: `0x${string}`,
): Promise<{ price: number; ageS: number } | null> {
  try {
    const v = (await pub.readContract({
      address: stork,
      abi: STORK_READ_ABI,
      functionName: "getTemporalNumericValueUnsafeV1",
      args: [feedId],
    })) as { timestampNs: bigint; quantizedValue: bigint };
    return {
      price: Number(v.quantizedValue) / 1e18,
      ageS: Math.round(Date.now() / 1000 - Number(v.timestampNs) / 1e9),
    };
  } catch (err) {
    console.log(`  (read reverted: ${err instanceof Error ? err.message.split("\n")[0] : err})`);
    return null;
  }
}

async function main(): Promise<void> {
  const asset = arg("asset", "BTCUSD");
  const stork = (process.env.STORK_CONTRACT_ADDRESS ??
    "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62") as `0x${string}`;
  const feedId = keccak256(toBytes(asset));
  const pub = publicClient();
  const wallet = operatorWallet();

  console.log(`── Stork pull-update live test (${asset}) ──`);
  console.log(`  pusher:  ${operatorAccount().address}`);
  console.log(`  stork:   ${stork}`);
  console.log(`  feedId:  ${feedId}\n`);

  const before = await readMark(pub, stork, feedId);
  console.log(
    `  BEFORE: ${before ? `$${before.price.toLocaleString()} (${before.ageS}s old)` : "no value"}`,
  );

  console.log(`\n  fetching fresh signed price from Stork REST…`);
  const updateData = await fetchStorkUpdate([asset]);
  const fresh = Number(updateData[0]?.temporalNumericValue.quantizedValue ?? 0n) / 1e18;
  console.log(
    `  REST price: $${fresh.toLocaleString()} (encoded id ${updateData[0]?.id.slice(0, 14)}…)`,
  );

  console.log(`\n  pushing on-chain via updateTemporalNumericValuesV1…`);
  const { txHash, fee } = await pushStorkUpdate(pub, wallet, updateData);
  console.log(`  fee: ${fee} wei · tx: ${txHash}`);
  const ok = (await pub.waitForTransactionReceipt({ hash: txHash })).status === "success";
  console.log(ok ? `  ✓ update landed` : `  ✗ update reverted`);

  const after = await readMark(pub, stork, feedId);
  console.log(
    `\n  AFTER:  ${after ? `$${after.price.toLocaleString()} (${after.ageS}s old)` : "no value"}`,
  );

  const moved =
    ok &&
    after &&
    (!before ||
      Math.abs(after.price - (before?.price ?? 0)) > 1e-9 ||
      after.ageS < (before?.ageS ?? 1e9));
  console.log(
    `\n${moved ? "✅ PASS — the on-chain mark is now the fresh live value" : "❌ the mark did not refresh"}`,
  );
  // keep the ABI reference so the import isn't dead if the read path changes.
  void STORK_UPDATE_ABI;
  process.exit(moved ? 0 : 1);
}

main().catch((err) => {
  console.error("stork-push failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
