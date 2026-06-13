/**
 * The agent policy primitive (Doc 2 §4.1). An agent is a *policy*: a pure function of (its own
 * account view, the latest market block state) → the {@link AgentAction} to take next block. This is
 * the live-venue analog of the Phase-1 sim's `Agent` interface (`engine/src/sim/agents.ts`), the
 * difference being the inputs are the *real* on-chain account + the engine's `MarketBlockState`
 * rather than the in-memory sim. Keeping the decision pure (no chain I/O, no SDK) makes it unit-
 * testable and keeps every archetype expressed as the unified-account thesis predicts: same account
 * primitive, distinguished only by policy.
 *
 * The {@link AgentRunner} (runner.ts) is the impure shell that reads the account, calls `decide`,
 * submits the action via the SDK, and answers margin calls. A policy never touches the wire.
 */

import type { AccountView, MarketBlockState } from "@sidekick/sdk";

/** What a policy decides to do this block. `open`/`close` map to the one position the account holds. */
export type AgentAction =
  | { kind: "none" }
  | { kind: "open"; side: "long" | "short"; collateral: string; leverage: number }
  | { kind: "close" };

/** The read-only context a policy sees each block: its own account + the market state. */
export interface PolicyCtx {
  /** This agent's joined on-chain account in the market (side, margin, equity, free collateral). */
  readonly view: AccountView;
  /** The latest per-block market state from the engine (mark, skew, funding, pool). */
  readonly state: MarketBlockState;
  /** The agent's local block counter since it started (0 on the first decision). */
  readonly block: number;
}

/**
 * An agent policy. `decide` is pure and runs once per block. `answersMarginCalls` declares whether
 * the runner should proactively answer this agent's margin calls via the x402 Gateway nanopayment —
 * the dark agent sets it false (that *is* its behaviour: go silent → decrement smoothly).
 */
export interface AgentPolicy {
  /** Stable id/label (also the HD role for the named demo agents). */
  readonly id: string;
  /** The archetype, for logging + the dashboard. */
  readonly kind: AgentKind;
  /** Whether the runner answers this agent's margin calls (false = the dark agent). */
  readonly answersMarginCalls: boolean;
  /** Decide the next action from the current context. */
  decide(ctx: PolicyCtx): AgentAction;
}

export type AgentKind = "long" | "short" | "mm" | "funding-strategy" | "dark";

/** Convenience: a flat (no-position) account view, so a policy can branch on `view.side`. */
export function isFlat(view: AccountView): boolean {
  return view.side === "flat";
}
