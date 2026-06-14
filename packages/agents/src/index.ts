/**
 * @sidekick/agents — the autonomous demo agents (Doc 2 Phase 4), all built on @sidekick/sdk. Each is
 * a small autonomous loop: subscribe to the per-block state, decide, act, repeat — no human in the
 * loop (the literal "agent-to-agent, no human intervention" claim).
 *
 *   - long / short      — open a position, hold, answer per-block margin calls (x402 Gateway). The
 *                         baseline healthy participants + the book's two sides.
 *   - mm                — watch pool skew vs cap; take the balancing side so skew self-corrects.
 *   - funding-strategy  — THE HERO: hold ~pure funding exposure by riding the funding-receiving side
 *                         and re-centering each block (impossible on an 8h-funding human venue).
 *   - dark              — go deliberately silent → the venue decrements it smoothly (no liquidation).
 *
 * The pure policies (`policies.ts`) are unit-testable; the `AgentRunner` (`runner.ts`) is the impure
 * shell that drives one against the live venue via the SDK. The orchestrator (`orchestrator.ts`)
 * composes all five into the Doc 3 §11 scenario; standalone `agent:<role>` entries run one each.
 *
 * Run order: `bun run fund` (onboard each agent's Circle wallet) → `bun run demo` (orchestrate), with
 * the engine live (`bun run dev` in packages/engine). The fleet signs through Circle MPC wallets only —
 * no HD/raw-key fallback. See the package README.
 */

export const AGENTS_VERSION = "0.4.0" as const;

// Config helpers.
export {
  agentMarket,
  type CircleFleetConfig,
  circleFleetConfig,
  circleSkForRole,
  engineUrl,
  loadRootEnv,
  requireCircleFleet,
} from "./config.ts";
export { type BuildOptions, type BuiltAgent, buildAgent, sdkForRole } from "./factory.ts";
export {
  AGENT_KINDS,
  type DarkConfig,
  type DarkPolicy,
  type DirectionalConfig,
  darkPolicy,
  directionalPolicy,
  type FundingConfig,
  fundingStrategyPolicy,
  isDarkPolicy,
  type MMConfig,
  mmPolicy,
} from "./policies.ts";
// Policy primitive + the five archetypes (pure, testable).
export type { AgentAction, AgentKind, AgentPolicy, PolicyCtx } from "./policy.ts";
export { isFlat } from "./policy.ts";
// The autonomous shell + wiring.
export { AgentRunner, type AgentRunnerConfig, type AgentStep } from "./runner.ts";
// The scripted scenario (per-role params + staging).
export { DARK_GOES_SILENT_AFTER, policyForRole, type RoleParams, SCENARIO } from "./scenario.ts";
