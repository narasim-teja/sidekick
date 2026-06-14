/**
 * `register-identities` — register the five demo agents as **real ERC-8004 agents** on Arc's
 * canonical Identity Registry, then mirror each minted `agentId` into the venue's AccountManager.
 *
 * This is what turns the demo fleet from anonymous wallets into discoverable, reputation-bearing agents
 * (Doc 1 §8): each role's Circle wallet calls `register()` on the on-chain Identity Registry (minting an
 * identity NFT whose `agentWallet` defaults to that Circle wallet address — the same address that
 * answers margin calls), and `linkIdentity(agentId)` on our AccountManager so `/venue` + the
 * unified-account view carry it.
 *
 * SAFETY: each `register()` is a real on-chain mint that spends USDC gas (from the role's Circle wallet,
 * which must be funded by address first). This script is **dry by default** — it shows what it WOULD do.
 * Pass `--broadcast` to actually mint. Already-registered roles (non-zero `identityOf`) are skipped, so
 * re-running is idempotent and cheap.
 *
 * Run: `bun run src/scripts/register-identities.ts [--only long,mm] [--broadcast]`. Requires the fleet's
 * Circle config (CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + per-role wallet ids).
 */

import { AGENT_ROLES, type AgentRole } from "@sidekick/sdk";
import { circleSkForRole, hasFlag, loadRootEnv } from "../config.ts";

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
  const broadcast = hasFlag("broadcast");
  const roles = rolesArg();

  console.log("── SideKick ERC-8004 identity registration ──");
  console.log(
    broadcast
      ? "MODE: broadcast (real on-chain mints, spends USDC gas from each role's Circle wallet)\n"
      : "MODE: dry-run (no txns — pass --broadcast to mint)\n",
  );

  for (const role of roles) {
    const sk = await circleSkForRole(role); // Circle MPC wallet for this role (no raw key)
    const address = sk.address;

    const existing = await sk.agentIdentity();
    if (existing.linked) {
      console.log(
        `▸ ${role} ${address}: already agent #${existing.agentId} (${existing.namespacedId}) — skip`,
      );
      continue;
    }

    if (!broadcast) {
      console.log(
        `▸ ${role} ${address}: would register() on the Identity Registry + linkIdentity(agentId)`,
      );
      continue;
    }

    try {
      const res = await sk.registerAgent();
      const ident = await sk.agentIdentity();
      console.log(`▸ ${role} ${address}: registered agent #${res.agentId}`);
      console.log(`  register tx: ${res.registerTx}`);
      if (res.linkTx) console.log(`  link tx    : ${res.linkTx}`);
      console.log(`  identity   : ${ident.namespacedId}\n`);
    } catch (err) {
      console.log(
        `  ✗ register failed: ${err instanceof Error ? err.message.split("\n")[0] : err}\n`,
      );
    }
  }

  console.log("identity registration complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("register-identities failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
