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
import { circleSigner } from "@sidekick/sdk/circle";
import { agentMarket, agentsMnemonic, circleFleetConfig, engineUrl } from "./config.ts";
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

/**
 * Construct a `SideKick` client for a role (Circle-first). If the fleet is Circle-configured (see
 * {@link circleFleetConfig}) and this role has a Circle wallet id, the client signs via a Circle MPC
 * wallet (no raw key). Otherwise it falls back to the role's HD-derived key off `AGENTS_MNEMONIC` —
 * the reproducible local demo path. Async because the Circle signer resolves the wallet via Circle's API.
 */
export async function sdkForRole(role: AgentRole, opts: BuildOptions = {}): Promise<SideKick> {
  const env = opts.env ?? process.env;
  const circle = circleFleetConfig(env);
  const walletId = circle?.walletIdFor(role);
  if (circle && walletId) {
    const { account, broadcaster } = await circleSigner({
      apiKey: circle.apiKey,
      entitySecret: circle.entitySecret,
      walletId,
    });
    return new SideKick({
      network: "arc-testnet",
      account,
      broadcaster,
      engineUrl: engineUrl(env),
    });
  }
  // HD-derived raw key (Doc 1 §5 Layer B) — the reproducible demo fallback when Circle isn't configured.
  const id = deriveDemoAgents(agentsMnemonic(env))[role];
  return new SideKick({
    network: "arc-testnet",
    privateKey: id.privateKey,
    engineUrl: engineUrl(env),
  });
}

/** Build a fully-wired agent (SDK + runner) for a role. Async — the signer may resolve via Circle. */
export async function buildAgent(role: AgentRole, opts: BuildOptions = {}): Promise<BuiltAgent> {
  const env = opts.env ?? process.env;
  const market = opts.market ?? agentMarket(env);
  const sk = await sdkForRole(role, opts);
  const policy = policyForRole(role);
  const runner = new AgentRunner({
    sk,
    policy,
    market,
    onStep: opts.onStep ? (step) => opts.onStep?.(role, step) : undefined,
  });
  return { role, address: sk.address, sk, runner };
}
