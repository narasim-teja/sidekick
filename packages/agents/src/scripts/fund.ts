/**
 * `bun run fund` — onboard the demo agents from one funded seed (Doc 2 §4.1: "decide whether demo
 * agents pre-onboard via a script or self-onboard"; this is the pre-onboard path, and it scales to
 * 10–30 agents because it just walks the HD indices).
 *
 * What it does, per agent (long, short, mm, funding, dark):
 *   1. Transfer USDC from the funder (HD index 0) to the agent's EOA — on Arc, USDC is BOTH the gas
 *      token and the ERC-20 collateral, so this one transfer covers gas + trading collateral + the
 *      Gateway balance. The amount = vaultUSDC + gatewayUSDC + a gas buffer (per `scenario.ts`).
 *   2. Have the agent onboard itself via the SDK: deposit `vaultUSDC` into the Vault (trading
 *      collateral) and `gatewayUSDC` into its Circle Gateway unified balance (funds the x402
 *      margin-call nanopayments). The dark agent skips the Gateway deposit (it never answers calls).
 *
 * The funder (index 0) must hold enough USDC for all agents — fund it once at https://faucet.circle.com.
 * Idempotent-ish: re-running tops up again. Pass `--only long,funding` to fund a subset, `--dry` to
 * print the plan without sending.
 *
 * Requires: a running engine is NOT needed (this is pure chain I/O), but the venue must be deployed
 * (it is — `@sidekick/shared` deployments). `AGENTS_MNEMONIC` should be a funded seed for a real run.
 */

import {
  AGENT_ROLES,
  type AgentRole,
  deriveDemoAgents,
  deriveFunder,
  formatUsdc,
  parseUsdc,
  SideKick,
} from "@sidekick/sdk";
import { ARC_TESTNET_DEPLOYMENT, arcTestnet, rpcUrl } from "@sidekick/shared";
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { agentsMnemonic, engineUrl, hasFlag, loadRootEnv, usingDevMnemonic } from "../config.ts";
import { SCENARIO } from "../scenario.ts";

/** A gas buffer (decimal USDC) sent on top of trading + Gateway funds, so each agent can pay its txns. */
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
  const mnemonic = agentsMnemonic();
  const funder = deriveFunder(mnemonic);
  const agents = deriveDemoAgents(mnemonic);
  const roles = rolesToFund();

  const chain = arcTestnet();
  const rpc = rpcUrl();
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const funderWallet = createWalletClient({ account: funder.account, chain, transport: http(rpc) });
  const usdc = ARC_TESTNET_DEPLOYMENT.usdc;

  console.log("── SideKick agent funding ──");
  console.log(`  funder (idx 0): ${funder.address}`);
  if (usingDevMnemonic())
    console.log("  ⚠ DEV mnemonic — fund index 0 of a real seed for a live run.");

  const funderBal = (await pub.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [funder.address],
  })) as bigint;
  console.log(`  funder USDC:    ${formatUsdc(funderBal)}\n`);

  // Plan: total each agent needs from the funder.
  let totalNeeded = 0n;
  for (const role of roles) {
    const p = SCENARIO[role];
    totalNeeded += parseUsdc(p.vaultUSDC) + parseUsdc(p.gatewayUSDC) + parseUsdc(GAS_BUFFER_USDC);
  }
  console.log(`  plan: fund ${roles.length} agent(s), total ${formatUsdc(totalNeeded)} USDC\n`);
  if (funderBal < totalNeeded && !dry) {
    throw new Error(
      `funder holds ${formatUsdc(funderBal)} USDC but the plan needs ${formatUsdc(totalNeeded)}. ` +
        "Fund the funder at https://faucet.circle.com.",
    );
  }

  for (const role of roles) {
    const id = agents[role];
    const p = SCENARIO[role];
    const transfer = parseUsdc(p.vaultUSDC) + parseUsdc(p.gatewayUSDC) + parseUsdc(GAS_BUFFER_USDC);
    console.log(
      `▸ ${role} ${id.address}: send ${formatUsdc(transfer)} USDC ` +
        `(vault ${p.vaultUSDC} + gateway ${p.gatewayUSDC} + gas ${GAS_BUFFER_USDC})`,
    );
    if (dry) continue;

    // 1. Transfer USDC funder → agent (covers gas + collateral + gateway).
    const tx = await funderWallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [id.address, transfer],
      chain,
      account: funder.account,
    });
    const ok = (await pub.waitForTransactionReceipt({ hash: tx })).status === "success";
    if (!ok) {
      console.log(`  ✗ transfer reverted (${tx}) — skipping onboard`);
      continue;
    }
    console.log(`  ✓ transferred (${tx})`);

    // 2. Agent onboards itself (Vault deposit + Gateway deposit). Dark skips the Gateway balance.
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

  console.log(
    "funding complete. Run `bun run demo` to orchestrate the scenario, or `bun run agent:<role>`.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("fund failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
