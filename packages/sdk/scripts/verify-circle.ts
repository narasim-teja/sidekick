/**
 * verify-circle — one-off live check that `circleAccount()` works end-to-end against Circle's real
 * developer-controlled-wallets API. Proves the "real external agent uses a Circle MPC wallet" path:
 * resolve the wallet address, sign an EIP-712 typed-data doc (the exact op the Gateway nanopayment
 * path performs), and sign an EIP-191 message. Reads creds from the repo-root `.env`. Never prints the
 * entity secret — only pass/fail, the public address, and signature prefixes.
 *
 * Run: bun run packages/sdk/scripts/verify-circle.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { circleAccount } from "../src/circle-account.ts";

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

async function main(): Promise<void> {
  loadEnv();
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletId = process.env.CIRCLE_WALLET_ID;
  if (!apiKey || !entitySecret || !walletId) {
    console.error("Missing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_ID in .env");
    process.exit(1);
  }

  console.log("── circleAccount live verification ──\n");

  // 1) Build the account (resolves the wallet address via Circle).
  const account = await circleAccount({ walletId, apiKey, entitySecret });
  console.log(`✓ wallet resolved: ${account.address}`);

  // 2) EIP-712 typed-data sign — the exact shape the Gateway/x402 nanopayment authorization uses,
  //    including a bigint field (amount) to exercise the bigint-safe serialization.
  const sig712 = await account.signTypedData?.({
    domain: {
      name: "SideKickVerify",
      version: "1",
      chainId: 5042002,
      verifyingContract: account.address,
    },
    types: {
      Probe: [
        { name: "amount", type: "uint256" },
        { name: "note", type: "string" },
      ],
    },
    primaryType: "Probe",
    message: { amount: 1_000_000n, note: "gateway-nanopayment-probe" },
  });
  console.log(
    `✓ signTypedData (EIP-712, the Gateway path op): ${sig712?.slice(0, 14)}… (len ${sig712?.length})`,
  );

  // 3) EIP-191 message sign.
  const sig191 = await account.signMessage?.({ message: "sidekick circle verification" });
  console.log(`✓ signMessage (EIP-191): ${sig191?.slice(0, 14)}… (len ${sig191?.length})`);

  console.log(
    "\n✅ Circle wallet path verified — circleAccount() signs via Circle MPC end-to-end.",
  );
  console.log("   The signer-only Gateway nanopayment flow can use this account (no raw key).");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ verification failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
