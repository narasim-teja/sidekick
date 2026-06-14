/**
 * `bun run fund` — onboard the demo agents into the venue from the USDC each Circle wallet ALREADY
 * holds. The fleet signs through Circle developer-controlled (MPC) wallets — there is no HD seed to
 * fan out from — so funding is two steps:
 *
 *   1. (manual, once) Fund each role's Circle wallet ADDRESS with Arc-testnet USDC, directly from the
 *      faucet (https://faucet.circle.com). On Arc, USDC is BOTH the gas token and the ERC-20
 *      collateral, so one balance covers gas + trading collateral + the Gateway balance. Run this
 *      script with `--dry` first to print each wallet's address + the amount it needs.
 *   2. (this script) Each agent onboards itself via the SDK, signed by its Circle wallet: deposit
 *      `vaultUSDC` into the Vault (trading collateral) and `gatewayUSDC` into its Circle Gateway
 *      unified balance (funds the x402 margin-call nanopayments). The dark agent skips the Gateway
 *      deposit (it never answers calls). Both deposits are signer-only / broadcaster-driven — no raw
 *      key in this process.
 *
 * An agent whose Circle wallet isn't funded simply can't onboard (the deposit reverts) — it then holds
 * no position and doesn't trade. And an onboarded agent that later can't answer a margin call just
 * **decrements smoothly** (the venue's no-liquidation design), it does not error out.
 *
 * Requires: a running engine is NOT needed (this is pure chain I/O), but the venue must be deployed
 * (it is — `@sidekick/shared` deployments) and the fleet's Circle config set (CIRCLE_API_KEY +
 * CIRCLE_ENTITY_SECRET + per-role wallet ids). Pass `--only long,funding` for a subset, `--dry` to
 * print the plan (addresses + amounts) without sending.
 */

import { AGENT_ROLES, type AgentRole, formatUsdc, parseUsdc } from "@sidekick/sdk";
import { ARC_TESTNET_DEPLOYMENT, arcTestnet, rpcUrl } from "@sidekick/shared";
import { createPublicClient, erc20Abi, http } from "viem";
import { circleSkForRole, hasFlag, loadRootEnv } from "../config.ts";
import { SCENARIO } from "../scenario.ts";

/** A gas buffer (decimal USDC) each wallet should hold on top of trading + Gateway funds, for txns. */
const GAS_BUFFER_USDC = "0.5";

function rolesToFund(): AgentRole[] {
  const i = process.argv.indexOf("--only");
  if (i !== -1 && process.argv[i + 1]) {
    const want = (process.argv[i + 1] as string).split(",").map((s) => s.trim());
    return AGENT_ROLES.filter((r) => want.includes(r));
  }
  return [...AGENT_ROLES];
}

async function main(): Promise<void> {
  loadRootEnv();
  const dry = hasFlag("dry");
  const roles = rolesToFund();
  const pub = createPublicClient({ chain: arcTestnet(), transport: http(rpcUrl()) });
  const usdc = ARC_TESTNET_DEPLOYMENT.usdc;

  console.log("── SideKick agent onboarding (Circle MPC wallets) ──");
  console.log(
    "  fund each wallet's address below with Arc-testnet USDC (https://faucet.circle.com),",
  );
  console.log(
    "  then this script deposits Vault collateral + the Gateway balance from that balance.\n",
  );

  for (const role of roles) {
    const sk = await circleSkForRole(role); // Circle MPC wallet for this role (no raw key)
    const address = sk.address;
    const p = SCENARIO[role];
    // Vault collateral + Gateway balance + a gas buffer (everything paid in USDC on Arc).
    const need = parseUsdc(p.vaultUSDC) + parseUsdc(p.gatewayUSDC) + parseUsdc(GAS_BUFFER_USDC);
    const bal = (await pub.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;

    console.log(
      `▸ ${role} ${address}: holds ${formatUsdc(bal)} — needs ${formatUsdc(need)} ` +
        `(vault ${p.vaultUSDC} + gateway ${p.gatewayUSDC} + gas ${GAS_BUFFER_USDC})`,
    );
    if (dry) continue;
    if (bal < need) {
      console.log(
        `  ✗ insufficient — fund this Circle wallet at https://faucet.circle.com, then re-run\n`,
      );
      continue;
    }

    // Onboard: Vault deposit + Gateway deposit, signed by the Circle wallet. Dark skips the Gateway leg.
    try {
      const res = await sk.onboard({
        depositUSDC: p.vaultUSDC,
        gatewayUSDC: p.gatewayUSDC !== "0" ? p.gatewayUSDC : undefined,
      });
      if (res.vaultDepositTx)
        console.log(`  ✓ vault deposit ${p.vaultUSDC} (${res.vaultDepositTx})`);
      if (res.gatewayDepositTx)
        console.log(`  ✓ gateway deposit ${p.gatewayUSDC} (${res.gatewayDepositTx})`);
    } catch (err) {
      console.log(`  ✗ onboard failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
    console.log("");
  }

  console.log(
    "funding complete. Run `bun run demo` to orchestrate the scenario, or `bun run agent:<role>`.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("fund failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
