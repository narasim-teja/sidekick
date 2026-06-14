/**
 * `bun run reset` — close every demo agent's OPEN position on the agent market, leaving each wallet
 * flat. Run this before a fresh `bun run demo` when positions are left over from a prior run.
 *
 * Why it's needed: the directional/dark policies open exactly once "if flat". A position carried over
 * from an earlier run (a) blocks the agent from opening a fresh one, and (b) keeps its old `entryMark`
 * — so as the demo's synthetic mark drifts, a long's `notionalNow` shrinks with the mark and the call
 * line `m·notionalNow` falls alongside its equity, so it may never cross into a margin call. Closing
 * first means each agent reopens at the CURRENT mark (full notional), where the drift erodes it against
 * the full call line and the x402 nanopayment flow fires as intended.
 *
 * `closePosition` is `msg.sender`-scoped on-chain, so each position must be closed by its OWN wallet —
 * hence we build each role's Circle SK and close through it (the operator can't force-close them).
 */

import { AGENT_ROLES, type AgentRole } from "@sidekick/sdk";
import { agentMarket, circleSkForRole, loadRootEnv } from "../config.ts";

async function resetRole(role: AgentRole): Promise<void> {
  const market = agentMarket();
  const sk = await circleSkForRole(role);
  try {
    const view = await sk.getAccount(market);
    if (view.side === "flat") {
      console.log(`  · ${role.padEnd(8)} ${sk.address} already flat`);
      return;
    }
    console.log(
      `  · ${role.padEnd(8)} ${sk.address} closing ${view.side} (entry ${view.entryNotional}@$${view.entryMark})…`,
    );
    const tx = await sk.close(market);
    const ok = await sk.confirm(tx);
    console.log(ok ? `    ✓ closed (${tx})` : `    ✗ close reverted (${tx})`);
  } catch (err) {
    console.log(
      `    ✗ ${role} reset failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
    );
  } finally {
    sk.disconnect();
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  const market = agentMarket();
  console.log(`── SideKick reset: close all demo positions on ${market} ──\n`);
  // Sequential (not Promise.all) to keep the RPC load gentle — there are only a handful of agents.
  for (const role of AGENT_ROLES) await resetRole(role);
  console.log("\n  done — run `bun run demo` for a fresh scenario.");
  process.exit(0);
}

main().catch((err) => {
  console.error("reset failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
