/**
 * The five demo-agent policies (Doc 2 §4.1, Doc 3 §11) — pure decision functions over the live
 * account + market state. They are the live-venue port of the Phase-1 sim's reference behaviours
 * (`engine/src/sim/agents.ts`), which is the source of truth for "what each archetype does":
 *
 *   - long / short      — open once, hold; the baseline healthy participants + the book's skew.
 *   - mm                — arrive, take the *balancing* (minority) side; flip if the crowd flips.
 *   - funding-strategy  — THE HERO: ride the funding-*receiving* side, re-centering each block to
 *                         hold ~pure funding exposure (Doc 1 §2 Pattern 2; Doc 3 §11 step 2).
 *   - dark              — open, then stop answering calls (the no-liquidation / smooth-decrement proof).
 *
 * The *behaviours* are fixed; the *policy knobs* (sizing, leverage, when the MM arrives, deadbands)
 * are tuned here for a legible demo and are easy to adjust. Sizing is in decimal USDC strings and
 * leverage is client-side sugar (Doc 3 §8) — both flow straight into `SideKick.open`.
 *
 * One-position-per-account-per-market is a venue constraint (POC): to flip sides, a policy returns
 * `close` one block and `open` the next (exactly as the sim does). The runner enforces nothing here;
 * the policy expresses intent and the venue's single-position rule does the sequencing.
 */

import type { AgentKind, AgentPolicy, PolicyCtx } from "./policy.ts";
import { isFlat } from "./policy.ts";

/** Tunable shape shared by the directional archetypes. */
export interface DirectionalConfig {
  id: string;
  side: "long" | "short";
  collateral: string;
  leverage: number;
  /** Block to open at (lets the orchestrator stagger entries). Default 0 (open ASAP). */
  openAt?: number;
}

/** A plain directional trader: open once at `openAt`, then hold and answer its calls. */
export function directionalPolicy(cfg: DirectionalConfig): AgentPolicy {
  const openAt = cfg.openAt ?? 0;
  let opened = false;
  return {
    id: cfg.id,
    kind: cfg.side,
    answersMarginCalls: true,
    decide({ view, block }: PolicyCtx) {
      if (block >= openAt && isFlat(view) && !opened) {
        opened = true;
        return { kind: "open", side: cfg.side, collateral: cfg.collateral, leverage: cfg.leverage };
      }
      return { kind: "none" };
    },
  };
}

/** Config for the market-maker agent. */
export interface MMConfig {
  id?: string;
  collateral: string;
  leverage: number;
  /** Block to arrive at (the MM shows up mid-scenario to pull skew back). Default 0. */
  arriveAt?: number;
  /** Skew deadband: only flip to the new minority side once |skew| exceeds this. Default 0.05. */
  deadband?: number;
}

/**
 * The market-maker agent (Doc 1 §3.1 upside layer). Arrives at `arriveAt`, reads live skew, and
 * takes the *balancing* (minority) side to pull skew toward zero — sitting on the funding-receiving
 * side by construction (its revenue in the POC is funding carry; the impact rebate is Layer 3 /
 * STRETCH, not yet on-chain — see the agents README). Re-evaluates each block: if the crowd flips
 * past the deadband, it closes to re-open on the new minority side next block.
 */
export function mmPolicy(cfg: MMConfig): AgentPolicy {
  const arriveAt = cfg.arriveAt ?? 0;
  const deadband = cfg.deadband ?? 0.05;
  return {
    id: cfg.id ?? "mm",
    kind: "mm",
    answersMarginCalls: true,
    decide({ view, state, block }: PolicyCtx) {
      if (block < arriveAt) return { kind: "none" };
      // Balancing side = opposite the crowded side. Net long (skew > 0) → provide short.
      const desired: "long" | "short" = state.skew > 0 ? "short" : "long";
      if (isFlat(view)) {
        return { kind: "open", side: desired, collateral: cfg.collateral, leverage: cfg.leverage };
      }
      if (view.side !== desired && Math.abs(state.skew) > deadband) {
        return { kind: "close" }; // re-open on the correct side next block
      }
      return { kind: "none" };
    },
  };
}

/** Config for the funding-strategy (hero) agent. */
export interface FundingConfig {
  id?: string;
  collateral: string;
  leverage: number;
  openAt?: number;
  /**
   * Funding-rate deadband: only FLIP to the other side once the rate is decisively negative-for-a-long
   * / positive-for-a-short by more than this magnitude. Prevents close/open churn every block when the
   * rate dithers around 0 near equilibrium. Default 0.00002 (well inside the r_max=0.0005 clamp).
   */
  flipDeadband?: number;
}

/**
 * THE HERO — the funding-strategy agent (Doc 1 §2 Pattern 2; Doc 3 §11 step 2). It seeks *pure
 * funding exposure*: it positions on whichever side currently *receives* funding (the minority
 * side), so its cashflow is dominated by the per-block funding stream rather than a directional bet.
 * Each block it re-checks the sign of the funding rate and flips to stay on the receiving side — the
 * smooth, continuous funding capture that is impossible on an 8h-funding venue.
 *
 * Honest framing (Doc 2 §4.1 "how literal?"): true delta-neutrality needs the PT/YT leg split the
 * POC venue doesn't natively expose. This is the documented stand-in — a single position kept on the
 * funding-receiving side and re-centered every block — and we lead the demo with what's true.
 */
export function fundingStrategyPolicy(cfg: FundingConfig): AgentPolicy {
  const openAt = cfg.openAt ?? 0;
  const deadband = cfg.flipDeadband ?? 0.00002;
  return {
    id: cfg.id ?? "funding",
    kind: "funding-strategy",
    answersMarginCalls: true,
    decide({ view, state, block }: PolicyCtx) {
      if (block < openAt) return { kind: "none" };
      const rate = state.fundingRate;
      // rate > 0 → longs pay, shorts receive → to RECEIVE funding, be short (and vice versa).
      // When flat, open on the receiving side at the current sign (rate ≥ 0 ⇒ short).
      if (isFlat(view)) {
        const side: "long" | "short" = rate >= 0 ? "short" : "long";
        return { kind: "open", side, collateral: cfg.collateral, leverage: cfg.leverage };
      }
      // When positioned, only FLIP once the rate is decisively against the held side by more than the
      // deadband — so a rate dithering around 0 doesn't churn a close/open pair every block.
      const heldSidePays = view.side === "long" ? rate > deadband : rate < -deadband;
      if (heldSidePays) return { kind: "close" }; // the side we hold now PAYS → flip to the receiver
      return { kind: "none" };
    },
  };
}

/** Config for the dark agent. */
export interface DarkConfig {
  id?: string;
  collateral: string;
  /** Thin/high leverage so erosion bites and the decrement is visible. Default 20. */
  leverage?: number;
  openAt?: number;
  /** Block at which it goes silent (stops answering calls). Default = right after it opens. */
  goesDarkAt?: number;
}

/**
 * The dark agent (Doc 3 §11 step 3) — the anti-liquidation proof. It opens a thin, high-leverage
 * position, then deliberately **goes silent**: from `goesDarkAt` on, the runner must not answer its
 * margin calls, so the venue decrements it smoothly toward zero (no liquidation, no penalty, no
 * cliff). The "go silent" is expressed as `answersMarginCalls` flipping to false; since a policy is
 * stateless-per-call from the runner's POV for that flag, we model it as a small stateful policy that
 * reports its current darkness via {@link DarkPolicy.isDark}.
 */
export interface DarkPolicy extends AgentPolicy {
  /** Whether the agent is currently dark (the runner reads this each block to gate call-answering). */
  isDark(block: number): boolean;
}

export function darkPolicy(cfg: DarkConfig): DarkPolicy {
  const openAt = cfg.openAt ?? 0;
  const goesDarkAt = cfg.goesDarkAt ?? openAt + 1;
  const leverage = cfg.leverage ?? 20;
  let opened = false;
  return {
    id: cfg.id ?? "dark",
    kind: "dark",
    // Static flag is `false`; the runner consults `isDark(block)` for the live, time-gated truth.
    answersMarginCalls: false,
    isDark(block: number) {
      return block >= goesDarkAt;
    },
    decide({ view, block }: PolicyCtx) {
      if (block >= openAt && isFlat(view) && !opened) {
        opened = true;
        return { kind: "open", side: "long", collateral: cfg.collateral, leverage };
      }
      return { kind: "none" };
    },
  };
}

/** Type guard: is this a {@link DarkPolicy} (so the runner can read `isDark`)? */
export function isDarkPolicy(p: AgentPolicy): p is DarkPolicy {
  return p.kind === "dark" && typeof (p as DarkPolicy).isDark === "function";
}

/** All archetype kinds (for labels / the dashboard). */
export const AGENT_KINDS: readonly AgentKind[] = [
  "long",
  "short",
  "mm",
  "funding-strategy",
  "dark",
] as const;
