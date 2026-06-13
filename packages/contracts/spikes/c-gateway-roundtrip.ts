/**
 * Spike C — Gateway nanopayment round-trip (THE most important spike).
 *
 * Resolves the Layer B surface: Circle ships the `@circle-fin/x402-batching` SDK with a
 * high-level `GatewayClient` whose `chain: "arcTestnet"` is a first-class supported network
 * (Gateway domain 26). This spike:
 *   1. Connects the GatewayClient to Arc testnet with the funded key.
 *   2. Reads wallet + Gateway unified balances.
 *   3. Deposits a small amount of USDC into the Gateway unified balance (the one on-chain tx
 *      that funds all subsequent off-chain authorizations).
 *   4. Re-reads balances to confirm the unified balance updated.
 *
 * Confirms: the off-chain-authorization → batch-settle model is callable ON Arc testnet, and
 * the exact SDK calls Layer B is built on. The actual per-payment `pay()` authorization is an
 * EIP-3009 `TransferWithAuthorization` (zero gas) the SDK signs against the GatewayWallet — it
 * targets an x402 resource (seller) endpoint, which the engine provides in Phase 3; here we
 * prove the deposit + unified-balance precondition that every nanopayment draws against.
 *
 * Run: `bun run spike:gateway` (from repo root) — requires a funded PRIVATE_KEY in .env.
 *
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 0 Spike C
 * @see https://developers.circle.com/gateway/nanopayments/quickstarts/buyer
 */

import { GatewayClient } from "@circle-fin/x402-batching/client";
import { GATEWAY } from "@sidekick/shared";
import { banner, loadRootEnv, requireEnv } from "./_shared.ts";

loadRootEnv();

/** How much USDC to deposit into the Gateway unified balance for the spike (small, on-purpose). */
const DEPOSIT_USDC = "0.5";

async function main() {
  banner("Spike C — Gateway nanopayment round-trip (@circle-fin/x402-batching)");

  const privateKey = requireEnv("PRIVATE_KEY") as `0x${string}`;
  const rpcUrl = process.env.ALCHEMY_ARC_RPC_URL || process.env.ARC_RPC_URL;

  const client = new GatewayClient({
    chain: "arcTestnet", // Gateway domain 26 — first-class supported chain in the SDK
    privateKey,
    ...(rpcUrl ? { rpcUrl } : {}),
  });

  console.log(`chain alias:   arcTestnet (Gateway domain ${GATEWAY.arcDomainId})`);

  // 1. Read balances before.
  const before = await client.getBalances();
  console.log("\nbalances (before):");
  console.log(`  wallet USDC:        ${before.wallet.formatted}`);
  console.log(`  gateway available:  ${before.gateway.formattedAvailable}`);
  console.log(`  gateway total:      ${before.gateway.formattedTotal}`);

  // 2. Deposit into the Gateway unified balance if it is thin. This is the single on-chain tx
  //    that funds all subsequent off-chain (gas-free) nanopayment authorizations.
  const wantAtomic = BigInt(Math.round(Number(DEPOSIT_USDC) * 1e6)); // USDC has 6 decimals
  if (before.gateway.available >= wantAtomic) {
    console.log(
      `\nGateway already funded (${before.gateway.formattedAvailable} available) — skipping deposit.`,
    );
  } else if (before.wallet.balance < wantAtomic) {
    throw new Error(
      `Wallet USDC (${before.wallet.formatted}) is below the ${DEPOSIT_USDC} deposit. ` +
        "Note: Gateway moves the USDC ERC-20 (6dp), distinct from Arc's USDC-as-gas balance. " +
        "Fund the wallet's USDC token at https://faucet.circle.com.",
    );
  } else {
    console.log(`\ndepositing ${DEPOSIT_USDC} USDC into the Gateway unified balance…`);
    const dep = await client.deposit(DEPOSIT_USDC);
    if (dep.approvalTxHash) console.log(`  approval tx: ${dep.approvalTxHash}`);
    console.log(`  deposit tx:  ${dep.depositTxHash}`);
    console.log(`  deposited:   ${dep.formattedAmount} USDC by ${dep.depositor}`);
  }

  // 3. Read balances after to confirm the unified balance reflects the deposit.
  const after = await client.getBalances();
  console.log("\nbalances (after):");
  console.log(`  wallet USDC:        ${after.wallet.formatted}`);
  console.log(`  gateway available:  ${after.gateway.formattedAvailable}`);
  console.log(`  gateway total:      ${after.gateway.formattedTotal}`);

  const funded = after.gateway.available > 0n;
  banner(
    funded
      ? "Spike C PASS ✓ (Gateway unified balance is funded on Arc — Layer B precondition met)"
      : "Spike C INCOMPLETE — Gateway unified balance is still 0 (see notes above)",
  );
  console.log("Layer B per-payment authorizations (EIP-3009 TransferWithAuthorization, gas-free)");
  console.log("draw against this unified balance and settle via x402 batching in Phase 3.");
  process.exit(funded ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSpike C FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
