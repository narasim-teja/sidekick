/**
 * Synthetic agents for the Phase 1 simulation (Doc 2 §1.2). An agent is a *policy*: given the
 * latest block state and its own account, it decides (a) an {@link Action} to submit next block
 * and (b) how it answers a margin call. Agents are pure behavior — they hold no money; the
 * market owns all state. This is the unified-account thesis in code: every agent below drives
 * the *same* account primitive, distinguished only by its policy.
 *
 * The five Doc 2 §1.2 archetypes, plus two extras for stronger evidence:
 *   - long / short      — directional, varying size + leverage; answer calls from free collateral
 *   - skew-pusher       — a wave of longs to exercise convex funding + the OI cap (Layer 1/2)
 *   - dark              — stops answering margin calls → smooth decrement, not a cliff
 *   - mm                — arrives mid-sim on the balancing side; harvests funding carry
 *   - funding-strategy  — the hero: rides the funding-receiving (minority) side, ~delta-neutral
 *                         intent, demonstrating smooth per-block funding capture
 *   - gap-victim        — a thin long that the gap-event price jump pushes to E ≤ 0
 */

import type { Account } from "./account.ts";
import type { Action, BlockState, MarginCallResponder } from "./market.ts";

/** Read-only view an agent policy sees each block. */
export interface AgentCtx {
  readonly state: BlockState | null; // null on block 0 (before the first run)
  readonly account: Account;
  readonly block: number;
}

/**
 * An agent policy. `decide` runs once per block to produce the next action (open/close/none).
 * `respond` answers margin calls during the reconciliation pass. Both are pure w.r.t. the
 * agent's own strategy; they read account/market state but never mutate it.
 */
export interface Agent {
  readonly id: string;
  readonly kind: AgentKind;
  decide(ctx: AgentCtx): Action;
  readonly respond: MarginCallResponder;
}

export type AgentKind =
  | "long"
  | "short"
  | "skew-pusher"
  | "dark"
  | "mm"
  | "funding-strategy"
  | "gap-victim";

/** Always pay a margin call in full from free collateral (the well-behaved default). */
const payInFull: MarginCallResponder = ({ shortfall }) => shortfall;

/** Open once at block `openAt`, then hold (and answer calls) — a plain directional trader. */
export function directional(opts: {
  id: string;
  side: "long" | "short";
  notional: number;
  margin: number;
  openAt?: number;
}): Agent {
  const openAt = opts.openAt ?? 1;
  let opened = false;
  return {
    id: opts.id,
    kind: opts.side,
    respond: payInFull,
    decide({ account, block }) {
      if (block + 1 >= openAt && account.position.side === "flat" && !opened) {
        opened = true;
        return { kind: "open", side: opts.side, notional: opts.notional, margin: opts.margin };
      }
      return { kind: "none" };
    },
  };
}

/**
 * A wave of skew: opens a large long at `openAt` to crowd one side, exercising convex funding
 * (Layer 1) and — if big enough vs pool capital — the OI cap (Layer 2). Holds and pays calls.
 */
export function skewPusher(opts: {
  id: string;
  notional: number;
  margin: number;
  openAt?: number;
}): Agent {
  const inner = directional({ ...opts, side: "long" });
  return { ...inner, kind: "skew-pusher" };
}

/**
 * The dark agent: opens a thin (high-leverage) long, then goes silent — never answers a call.
 * On a human venue it gets liquidated at a penalty; here it decrements smoothly toward zero.
 */
export function darkAgent(opts: {
  id: string;
  notional: number;
  margin: number;
  goesDarkAt: number;
  openAt?: number;
}): Agent {
  const openAt = opts.openAt ?? 1;
  let opened = false;
  let dark = false;
  return {
    id: opts.id,
    kind: "dark",
    // Pays in full while live; once block ≥ goesDarkAt it never answers again → smooth decrement.
    respond: ({ shortfall }) => (dark ? 0 : shortfall),
    decide({ account, block }) {
      if (block >= opts.goesDarkAt) dark = true;
      if (block + 1 >= openAt && account.position.side === "flat" && !opened) {
        opened = true;
        return { kind: "open", side: "long", notional: opts.notional, margin: opts.margin };
      }
      return { kind: "none" };
    },
  };
}

/**
 * The market-maker agent (Doc 1 §3.1 upside layer). Arrives at `arriveAt`, reads live skew, and
 * takes the *balancing* (minority) side to pull skew toward zero — harvesting funding carry
 * (it sits on the funding-receiving side by construction). Re-evaluates each block: if the book
 * flips, it flips with it. Always answers its own calls.
 */
export function mmAgent(opts: {
  id: string;
  notional: number;
  margin: number;
  arriveAt: number;
}): Agent {
  return {
    id: opts.id,
    kind: "mm",
    respond: payInFull,
    decide({ state, account, block }) {
      if (block + 1 < opts.arriveAt) return { kind: "none" };
      if (!state) return { kind: "none" };
      // Balancing side = opposite of the crowded side. If net long (skew > 0), provide short.
      const desired: "long" | "short" = state.skew > 0 ? "short" : "long";
      if (account.position.side === "flat") {
        return { kind: "open", side: desired, notional: opts.notional, margin: opts.margin };
      }
      // Already positioned: if the crowd flipped past a deadband, re-balance to the new minority.
      if (account.position.side !== desired && Math.abs(state.skew) > 0.05) {
        return { kind: "close" }; // re-open on the next block on the correct side
      }
      return { kind: "none" };
    },
  };
}

/**
 * The hero — the funding-strategy agent (Doc 1 §2 Pattern 2; Doc 3 §11 step 2). It seeks *pure
 * funding exposure*: it positions on whichever side currently *receives* funding (the minority
 * side), so its cashflow is dominated by the per-block funding stream rather than a directional
 * bet. Each block it re-checks the sign of the funding rate and flips to stay on the receiving
 * side — the smooth, continuous funding capture that is impossible on an 8h-funding venue.
 *
 * (In the full venue this is the PT/YT split — hold the YT (funding) leg only. In the
 * single-market sim we approximate "pure funding exposure" by riding the funding-receiving side
 * and rebalancing every block; documented honestly as the sim's stand-in for the leg split.)
 */
export function fundingStrategyAgent(opts: {
  id: string;
  notional: number;
  margin: number;
  openAt?: number;
}): Agent {
  const openAt = opts.openAt ?? 1;
  return {
    id: opts.id,
    kind: "funding-strategy",
    respond: payInFull,
    decide({ state, account, block }) {
      if (block + 1 < openAt) return { kind: "none" };
      // rate > 0 → longs pay, shorts receive → to receive funding, be short (and vice versa).
      const receivingSide: "long" | "short" = !state || state.fundingRate >= 0 ? "short" : "long";
      if (account.position.side === "flat") {
        return { kind: "open", side: receivingSide, notional: opts.notional, margin: opts.margin };
      }
      if (account.position.side !== receivingSide) {
        return { kind: "close" }; // re-open on the receiving side next block
      }
      return { kind: "none" };
    },
  };
}

/**
 * The gap victim: a thin, high-leverage long sized so that the scenario's single-block price
 * gap drives its equity below zero, exercising the E ≤ 0 gap-fund branch (Doc 1 §4.2). Pays
 * normal calls (it is not dark) — only the violent gap, not slow erosion, takes it under.
 */
export function gapVictim(opts: {
  id: string;
  notional: number;
  margin: number;
  openAt?: number;
}): Agent {
  const inner = directional({ ...opts, side: "long" });
  return { ...inner, kind: "gap-victim" };
}
