/**
 * create-sidekick-wallets — create a SideKick-named developer-controlled wallet SET and N EOA wallets
 * on ARC-TESTNET under your Circle account. Each wallet's key is generated INSIDE Circle's 2-of-2 MPC
 * (never assembled/exported) — you get back only a walletId + public address. Signing for any of them
 * is authorized by your account's one entity secret (see [[agent-wallet-custody-models]]).
 *
 * Reads CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET from .env. Never prints the secret. Creating a set/wallets
 * is a "sensitive operation" — it uses the entity secret (its single-use ciphertext, SDK-generated).
 *
 * Run: bun run packages/sdk/scripts/create-sidekick-wallets.ts [--name sidekick-agents] [--count 5]
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

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = i !== -1 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}

async function main(): Promise<void> {
  loadEnv();
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    console.error("Missing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET in .env");
    process.exit(1);
  }
  const name = arg("name", "sidekick-agents");
  const count = Number(arg("count", "5"));

  // biome-ignore lint/suspicious/noExplicitAny: the SDK's ClientParams is broader than our usage.
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret } as any);

  console.log(`── creating SideKick wallet set "${name}" + ${count} ARC-TESTNET EOA wallets ──\n`);

  const set = await client.createWalletSet({ name });
  const walletSetId = set.data?.walletSet?.id;
  if (!walletSetId) throw new Error("createWalletSet returned no id");
  console.log(`✓ wallet set: ${walletSetId} ("${name}")\n`);

  const res = await client.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    accountType: "EOA",
    count,
  });
  const wallets = res.data?.wallets ?? [];
  console.log(`✓ ${wallets.length} wallet(s) — key in Circle MPC, only id+address returned:\n`);
  for (const w of wallets) {
    console.log(`  id=${w.id}  addr=${w.address}  (${w.blockchain}, ${w.accountType}, ${w.state})`);
  }

  console.log(
    `\nNext: set CIRCLE_WALLET_SET_ID=${walletSetId} and CIRCLE_WALLET_ID=<one id above> in .env,\n` +
      "then fund that wallet's address with Arc-testnet USDC (faucet.circle.com) to trade.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
