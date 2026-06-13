/**
 * Wiring helpers that turn a role into a live agent: derive its HD key, construct the `SideKick`
 * client, build its policy, and assemble an `AgentRunner`. Shared by the standalone `agent:*` entries
 * and the orchestrator so identity + config are identical across both.
 *
 * Each agent is its own EOA (Doc 2 §4.1) derived from the one `AGENTS_MNEMONIC` (keys.ts) — so 5 or
 * 30 agents are just 5 or 30 indices off one seed, each a fully independent unified account.
 */

import type { MarketSymbol } from "@sidekick/sdk";
import { type AgentRole, deriveDemoAgents, SideKick } from "@sidekick/sdk";
import { agentMarket, agentsMnemonic, engineUrl } from "./config.ts";
import { AgentRunner, type AgentStep } from "./runner.ts";
import { policyForRole } from "./scenario.ts";

/** A constructed agent: its role, address, SDK client, and runner. */
export interface BuiltAgent {
  role: AgentRole;
  address: `0x${string}`;
  sk: SideKick;
  runner: AgentRunner;
}

export interface BuildOptions {
  /** Override the market (else from env). */
  market?: MarketSymbol;
  /** Step callback wired into the runner. */
  onStep?: (role: AgentRole, step: AgentStep) => void;
  /** Shared env (tests). */
  env?: Record<string, string | undefined>;
}

/** Construct a `SideKick` client for a role's HD-derived key. */
export function sdkForRole(role: AgentRole, opts: BuildOptions = {}): SideKick {
  const env = opts.env ?? process.env;
  const agents = deriveDemoAgents(agentsMnemonic(env));
  const id = agents[role];
  // A raw private key (not a viem signer) so the Gateway nanopayment path works (Doc 1 §5 Layer B).
  return new SideKick({
    network: "arc-testnet",
    privateKey: id.privateKey,
    engineUrl: engineUrl(env),
  });
}

/** Build a fully-wired agent (SDK + runner) for a role. */
export function buildAgent(role: AgentRole, opts: BuildOptions = {}): BuiltAgent {
  const env = opts.env ?? process.env;
  const market = opts.market ?? agentMarket(env);
  const sk = sdkForRole(role, opts);
  const policy = policyForRole(role);
  const runner = new AgentRunner({
    sk,
    policy,
    market,
    onStep: opts.onStep ? (step) => opts.onStep?.(role, step) : undefined,
  });
  return { role, address: sk.address, sk, runner };
}
