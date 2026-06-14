/**
 * create-payer-wallet — create ONE additional ARC-TESTNET EOA wallet INSIDE the EXISTING
 * `CIRCLE_WALLET_SET_ID`, for the standalone `payer` agent (the x402 nanopayment demo). Unlike
 * create-sidekick-wallets (which makes a NEW set), this reuses the current set so the 5 fleet wallets
 * are untouched. Prints the new `walletId` + address — set `CIRCLE_WALLET_ID_PAYER=<id>` in .env and
 * fund the address at faucet.circle.com.
 *
 * Run: bun run packages/sdk/scripts/create-payer-wallet.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

function loadEnv(): void {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8");
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

async function main(): Promise<void> {
  loadEnv();
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!apiKey || !entitySecret) {
    console.error("Missing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET in .env");
    process.exit(1);
  }
  if (!walletSetId) {
    console.error("Missing CIRCLE_WALLET_SET_ID in .env (the existing set to add the wallet to).");
    process.exit(1);
  }

  // biome-ignore lint/suspicious/noExplicitAny: the SDK's ClientParams is broader than our usage.
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret } as any);

  console.log(`── creating 1 ARC-TESTNET EOA wallet in EXISTING set ${walletSetId} (for the payer) ──\n`);

  const res = await client.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    accountType: "EOA",
    count: 1,
  });
  const w = res.data?.wallets?.[0];
  if (!w) throw new Error("createWallets returned no wallet");

  console.log(`✓ payer wallet — key in Circle MPC, only id+address returned:\n`);
  console.log(`  id=${w.id}  addr=${w.address}  (${w.blockchain}, ${w.accountType}, ${w.state})\n`);
  console.log("Next steps:");
  console.log(`  1. set in .env:   CIRCLE_WALLET_ID_PAYER=${w.id}`);
  console.log(`  2. fund the address with Arc-testnet USDC: https://faucet.circle.com → ${w.address}`);
  console.log("  3. run: bun run agent:payer  (it self-onboards: deposits collateral + Gateway, drains free collateral)");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
