/**
 * Wiring helpers that turn a role into a live agent: resolve its Circle MPC wallet, construct the
 * `SideKick` client, build its policy, and assemble an `AgentRunner`. Shared by the standalone
 * `agent:*` entries and the orchestrator so identity + config are identical across both.
 *
 * Each agent signs through its own Circle developer-controlled wallet (Doc 1 §8 / the Circle Agent
 * Stack ask) — there is no HD/mnemonic or raw-key fallback. The role→wallet resolution + fail-loud
 * lives in {@link circleSkForRole}.
 */

import type { AgentRole, MarketSymbol, SideKick } from "@sidekick/sdk";
import { agentMarket, circleSkForRole } from "./config.ts";
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
 * Construct a `SideKick` client for a role, signing through the role's Circle MPC wallet (no raw key).
 * Throws if Circle isn't configured for this role. Async because the Circle signer resolves the wallet
 * via Circle's API.
 */
export async function sdkForRole(role: AgentRole, opts: BuildOptions = {}): Promise<SideKick> {
  return circleSkForRole(role, opts.env ?? process.env);
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
