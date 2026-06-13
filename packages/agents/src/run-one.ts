/**
 * `runOne` — the shared body of each standalone `agent:<role>` entry. It loads env, builds the agent
 * for the role, prints its identity, starts the autonomous loop, and stays up until Ctrl-C. The
 * per-role entry files (`agents/long.ts`, etc.) are one line each on top of this.
 *
 * Standalone is the "raw" mode: it does NOT onboard (fund) the agent — run `bun run fund` once first
 * (or `bun run demo`, which funds + orchestrates). Trying to act with an unfunded account just reverts
 * (insufficient free collateral), which the runner logs without crashing.
 */

import type { AgentRole } from "@sidekick/sdk";
import { agentMarket, loadRootEnv, usingDevMnemonic } from "./config.ts";
import { buildAgent } from "./factory.ts";

export async function runOne(role: AgentRole): Promise<void> {
  loadRootEnv();
  const market = agentMarket();
  const agent = buildAgent(role, { market });

  console.log(`── SideKick agent: ${role} ──`);
  console.log(`  address: ${agent.address}`);
  console.log(`  market:  ${market}`);
  console.log(`  engine:  ${agent.sk.engineUrl}`);
  if (usingDevMnemonic()) {
    console.log("  ⚠ using the public DEV mnemonic — set AGENTS_MNEMONIC for a real run.");
  }
  console.log("  starting loop (Ctrl-C to stop)…\n");

  agent.runner.start();

  const shutdown = () => {
    console.log(`\n[agent:${role}] stopping…`);
    agent.runner.stop();
    agent.sk.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive; the runner reacts to WS frames.
  await new Promise<never>(() => {});
}
