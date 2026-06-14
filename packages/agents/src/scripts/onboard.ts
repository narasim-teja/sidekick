/**
 * `onboard` — onboard the demo agents into the venue using the USDC they ALREADY hold (no funder
 * transfer). Use this when each agent EOA was funded directly (e.g. from the faucet) rather than
 * fanned out from the funder. Each agent deposits its scenario `vaultUSDC` into the Vault (trading
 * collateral) and `gatewayUSDC` into its Circle Gateway unified balance (the x402 margin-call rail).
 *
 * Run: `bun run src/scripts/onboard.ts [--only long,funding] [--dry]`. Requires AGENTS_MNEMONIC.
 */

import {
  AGENT_ROLES,
  type AgentRole,
  deriveDemoAgents,
  formatUsdc,
  parseUsdc,
  SideKick,
} from "@sidekick/sdk";
import { ARC_TESTNET_DEPLOYMENT, arcTestnet, rpcUrl } from "@sidekick/shared";
import { createPublicClient, erc20Abi, http } from "viem";
import { agentsMnemonic, engineUrl, hasFlag, loadRootEnv } from "../config.ts";
import { SCENARIO } from "../scenario.ts";

function rolesArg(): AgentRole[] {
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
  const agents = deriveDemoAgents(agentsMnemonic());
  const roles = rolesArg();
  const pub = createPublicClient({ chain: arcTestnet(), transport: http(rpcUrl()) });
  const usdc = ARC_TESTNET_DEPLOYMENT.usdc;

  console.log("── SideKick agent onboarding (from each agent's own balance) ──\n");

  for (const role of roles) {
    const id = agents[role];
    const p = SCENARIO[role];
    const need = parseUsdc(p.vaultUSDC) + parseUsdc(p.gatewayUSDC);
    const bal = (await pub.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [id.address],
    })) as bigint;

    console.log(
      `▸ ${role} ${id.address}: holds ${formatUsdc(bal)} — onboard vault ${p.vaultUSDC} + gateway ${p.gatewayUSDC}`,
    );
    if (bal < need) {
      console.log(`  ✗ insufficient (needs ${formatUsdc(need)} + gas) — skipping`);
      continue;
    }
    if (dry) continue;

    const sk = new SideKick({
      network: "arc-testnet",
      privateKey: id.privateKey,
      engineUrl: engineUrl(),
    });
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

  console.log("onboarding complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("onboard failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
