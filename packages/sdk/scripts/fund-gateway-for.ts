/**
 * fund-gateway-for — deposit into a *target* address's Circle Gateway unified balance ON ITS BEHALF,
 * paid by the funded deployer (PRIVATE_KEY). Uses Circle's `GatewayClient.depositFor(amount, depositor)`.
 *
 * Why: the Gateway *deposit* leg currently needs a raw key (Circle's GatewayClient constructor). A
 * Circle-MPC wallet can ANSWER margin calls gas-free (signer-only x402), but can't yet fund its own
 * Gateway balance through the SDK. So we top up its Gateway balance from the deployer once; thereafter
 * the Circle wallet answers calls against that balance with no raw key. (Funding the answer-source is a
 * one-time setup move; the per-call settlement is what must be key-free, and it is.)
 *
 * Run: bun run packages/sdk/scripts/fund-gateway-for.ts <targetAddress> <amountUSDC>
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GatewayClient } from "@circle-fin/x402-batching/client";

function envValue(key: string): string | undefined {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8");
    const line = raw.split("\n").find((l) => l.trim().startsWith(`${key}=`));
    if (!line) return undefined;
    return line
      .slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const target = process.argv[2] as `0x${string}` | undefined;
  const amount = process.argv[3];
  if (!target || !amount) {
    console.error("usage: fund-gateway-for.ts <targetAddress> <amountUSDC>");
    process.exit(1);
  }
  const pkRaw = envValue("PRIVATE_KEY");
  if (!pkRaw) {
    console.error("PRIVATE_KEY (the funded deployer) not found in .env");
    process.exit(1);
  }
  const privateKey = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as `0x${string}`;

  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });
  console.log(
    `depositing ${amount} USDC into Gateway balance of ${target} (paid by ${gateway.address})…`,
  );
  const res = await gateway.depositFor(amount, target);
  console.log(`  approval tx: ${res.approvalTxHash ?? "(skipped)"}`);
  console.log(`  deposit tx:  ${res.depositTxHash}`);

  const bal = await gateway.getBalances(target);
  console.log(`  target Gateway available now: ${bal.gateway.formattedAvailable} USDC`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`fund-gateway-for failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
