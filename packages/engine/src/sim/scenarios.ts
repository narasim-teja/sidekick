/**
 * Scenarios (Doc 2 §1.2) — each composes a price path + a set of agents into a named,
 * reproducible run, plus the `runScenario` driver that threads the per-block loop.
 *
 * The five Doc 2 §1.2 scenarios, plus extras for stronger evidence:
 *   1. mixed-book        — a few longs + shorts of varying size/leverage (baseline)
 *   2. skew-wave         — a wave of longs to exercise convex funding + the OI cap
 *   3. dark-decrement    — a dark agent decrements smoothly vs a cliff
 *   4. mm-rebalance      — an MM arrives mid-sim, pool goes thin, skew self-corrects
 *   5. gap-event         — a single-block price jump hits the E ≤ 0 gap-fund branch
 *   6. funding-hero      — the funding-strategy agent holds ~pure funding exposure (hero demo)
 *   7. stress            — everything at once: longs/shorts/MM/dark/funding/gap over a long run
 */

import { getMarket, type MarketParams } from "@sidekick/shared";
import { makeAccount } from "./account.ts";
import {
  type Agent,
  darkAgent,
  directional,
  fundingStrategyAgent,
  gapVictim,
  mmAgent,
  skewPusher,
} from "./agents.ts";
import { type Action, type BlockState, makeMarket, runBlock } from "./market.ts";
import { makePool } from "./pool.ts";
import { flatPath, gbmPath } from "./price.ts";

/** A fully-specified, reproducible scenario. */
export interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Mark path; `path[b]` is the mark at block b (index 0 = pre-sim seed). */
  readonly path: number[];
  /** Pool seed: backing capital and gap-fund reserve, in USDC. */
  readonly pool: { capital: number; gapFund: number };
  /** Per-agent: the policy + the free collateral its account starts with. */
  readonly agents: { agent: Agent; collateral: number }[];
  /** Optional param override; defaults to the BTC market's params. */
  readonly params?: MarketParams;
}

/** The result of running a scenario: the per-block state series + the final markets/accounts. */
export interface ScenarioRun {
  readonly scenario: Scenario;
  readonly states: BlockState[];
  readonly params: MarketParams;
}

const BTC_PARAMS = getMarket("BTC-PERP").params;

/**
 * Drive a scenario block by block: gather each agent's action, run the §4.3 loop with that
 * agent's margin-call responder, and feed the resulting state back to the agents for the next
 * block. Pure and deterministic for a given scenario.
 */
export function runScenario(scenario: Scenario, paramsOverride?: MarketParams): ScenarioRun {
  const params = paramsOverride ?? scenario.params ?? BTC_PARAMS;
  const pool = makePool(scenario.pool.capital, scenario.pool.gapFund);
  const accounts = scenario.agents.map((a) => makeAccount(a.agent.id, a.collateral));
  const market = makeMarket(params, pool, accounts);
  const byId = new Map(scenario.agents.map((a) => [a.agent.id, a.agent]));

  const states: BlockState[] = [];
  let last: BlockState | null = null;
  const blocks = scenario.path.length - 1;

  for (let b = 1; b <= blocks; b += 1) {
    const mark = scenario.path[b] as number;

    // 1. Each agent decides its action for this block from the last observed state.
    const actions = new Map<string, Action>();
    for (const acct of market.accounts.values()) {
      const agent = byId.get(acct.id);
      if (!agent) continue;
      actions.set(acct.id, agent.decide({ state: last, account: acct, block: b }));
    }

    // 2. Run the block, routing margin calls to the owning agent's responder.
    const state = runBlock(market, mark, actions, (ctx) => {
      const agent = byId.get(ctx.account.id);
      return agent ? agent.respond(ctx) : 0;
    });

    states.push(state);
    last = state;
  }

  return { scenario, states, params };
}

// ── Scenario builders (Doc 2 §1.2 + extras) ───────────────────────────────────────

const BTC_START = 70_000;

/** 1. Mixed book — a few longs + shorts of varying size/leverage; the calm baseline. */
export function mixedBook(blocks = 600): Scenario {
  return {
    name: "mixed-book",
    description: "A few longs + shorts of varying size/leverage over a noisy flat-ish market.",
    path: gbmPath({ blocks, start: BTC_START, volPerBlock: 0.0004, seed: 11 }),
    pool: { capital: 1_000_000, gapFund: 20_000 },
    agents: [
      {
        agent: directional({ id: "long-1", side: "long", notional: 50_000, margin: 5_000 }),
        collateral: 20_000,
      },
      {
        agent: directional({ id: "long-2", side: "long", notional: 30_000, margin: 6_000 }),
        collateral: 15_000,
      },
      {
        agent: directional({ id: "short-1", side: "short", notional: 40_000, margin: 4_000 }),
        collateral: 20_000,
      },
      {
        agent: directional({ id: "short-2", side: "short", notional: 25_000, margin: 5_000 }),
        collateral: 12_000,
      },
    ],
  };
}

/** 2. Skew wave — a crowd of longs builds skew toward +1; convex funding ramps, OI cap engages. */
export function skewWave(blocks = 600): Scenario {
  // A realistic "wave" is many traders arriving in quick succession, not one giant block — so
  // skew climbs smoothly (no single-block whipsaw) while cumulative demand still overshoots the
  // cap. 30 longs × $80k = $2.4M of demand vs a k·$300k ≈ $900k cap → many later opens refused.
  const agents: Scenario["agents"] = [
    {
      agent: directional({ id: "short-anchor", side: "short", notional: 100_000, margin: 20_000 }),
      collateral: 30_000,
    },
  ];
  for (let i = 0; i < 30; i += 1) {
    agents.push({
      agent: skewPusher({ id: `wave-${i}`, notional: 80_000, margin: 12_000, openAt: 40 + i * 6 }),
      collateral: 14_000,
    });
  }
  return {
    name: "skew-wave",
    description: "A crowd of longs builds skew toward +1, exercising convex funding + the OI cap.",
    path: gbmPath({ blocks, start: BTC_START, volPerBlock: 0.0003, seed: 22 }),
    pool: { capital: 300_000, gapFund: 10_000 }, // k=3 → ~$900k cap, overshot by the $2.4M wave
    agents,
  };
}

/** 3. Dark decrement — one agent goes silent; watch smooth decrement, not a cliff. */
export function darkDecrement(blocks = 600): Scenario {
  return {
    name: "dark-decrement",
    description: "A dark agent stops answering calls; its notional trends smoothly to zero.",
    // A sustained downward drift erodes the dark long's equity via adverse price (the dominant
    // term) plus funding it won't answer. ~−6%/100 blocks past the dark point, so it trims down
    // smoothly rather than gapping (no single block big enough to cross E ≤ 0 from healthy).
    path: gbmPath({
      blocks,
      start: BTC_START,
      driftPerBlock: -0.0006,
      volPerBlock: 0.0003,
      seed: 33,
    }),
    pool: { capital: 1_000_000, gapFund: 20_000 },
    agents: [
      // A well-margined crowded long book holds the other side and keeps absorbing decremented size.
      {
        agent: directional({ id: "long-crowd", side: "long", notional: 200_000, margin: 60_000 }),
        collateral: 200_000,
      },
      // The dark agent: opens a 10× long (margin = collateral, so nothing left to answer calls),
      // goes dark at block 100, and never tops up — it can only decrement from there.
      {
        agent: darkAgent({ id: "dark", notional: 100_000, margin: 10_000, goesDarkAt: 100 }),
        collateral: 10_000,
      },
    ],
  };
}

/** 4. MM rebalance — an MM arrives mid-sim, takes the balancing side, skew self-corrects. */
export function mmRebalance(blocks = 700): Scenario {
  return {
    name: "mm-rebalance",
    description: "Skew builds; an MM-agent arrives at block 200, pulls skew back, harvests carry.",
    path: gbmPath({ blocks, start: BTC_START, volPerBlock: 0.0003, seed: 44 }),
    pool: { capital: 600_000, gapFund: 15_000 },
    agents: [
      {
        agent: skewPusher({ id: "crowd-1", notional: 300_000, margin: 50_000, openAt: 20 }),
        collateral: 150_000,
      },
      {
        agent: skewPusher({ id: "crowd-2", notional: 300_000, margin: 50_000, openAt: 60 }),
        collateral: 150_000,
      },
      {
        agent: mmAgent({ id: "mm", notional: 400_000, margin: 80_000, arriveAt: 200 }),
        collateral: 250_000,
      },
    ],
  };
}

/** 5. Gap event — a single-block price jump drives a thin long below zero into the gap fund. */
export function gapEvent(blocks = 400): Scenario {
  const gapAt = 150;
  return {
    name: "gap-event",
    description: "A single-block −18% gap pushes a thin long to E ≤ 0, hitting the gap fund.",
    path: gbmPath({
      blocks,
      start: BTC_START,
      volPerBlock: 0.0002,
      seed: 55,
      gaps: [{ at: gapAt, factor: 0.82 }],
    }),
    pool: { capital: 1_000_000, gapFund: 50_000 },
    agents: [
      // Healthy long with plenty of buffer — survives the gap (decrements, no bad debt).
      {
        agent: directional({ id: "healthy-long", side: "long", notional: 100_000, margin: 20_000 }),
        collateral: 50_000,
      },
      // Thin 50× long: margin = collateral (nothing left to answer calls). A −18% gap is a
      // −$18k swing on $100k notional vs $2k margin → equity goes deeply negative in ONE block,
      // with no intermediate state to decrement through → the E ≤ 0 gap-fund branch.
      {
        agent: gapVictim({ id: "gap-victim", notional: 100_000, margin: 2_000, openAt: 10 }),
        collateral: 2_000,
      },
    ],
  };
}

/** 6. Funding hero — the funding-strategy agent holds ~pure funding exposure (the hero demo). */
export function fundingHero(blocks = 700): Scenario {
  return {
    name: "funding-hero",
    description:
      "The funding-strategy agent rides the funding-receiving side; smooth per-block funding capture.",
    // Flat price so the agent's PnL is dominated by funding, not price — 'pure funding exposure'.
    path: flatPath(blocks, BTC_START),
    pool: { capital: 1_000_000, gapFund: 20_000 },
    agents: [
      // A persistent crowded long book → positive funding → the hero sits short to receive it.
      {
        agent: directional({ id: "long-crowd", side: "long", notional: 300_000, margin: 60_000 }),
        collateral: 100_000,
      },
      {
        agent: fundingStrategyAgent({ id: "funding-hero", notional: 100_000, margin: 20_000 }),
        collateral: 50_000,
      },
    ],
  };
}

/**
 * 8. Funding-curve probe — ramps skew smoothly from ~0 to ~1 by opening many small longs in
 * staggered tranches against a fixed short anchor. This is the scenario that actually *traverses*
 * the skew range, so the funding-curve criterion (flat near balance → convex toward the extreme)
 * has data to judge. The persistent-skew scenarios pin S and can't show the shape; this one does.
 */
export function fundingCurveProbe(): Scenario {
  const tranches = 40;
  const blocks = tranches * 12 + 60; // space tranches out so S_smooth tracks each step
  const agents: Scenario["agents"] = [
    // Fixed short anchor so skew starts near 0 and climbs toward +1 as longs ramp in.
    {
      agent: directional({ id: "short-anchor", side: "short", notional: 200_000, margin: 40_000 }),
      collateral: 60_000,
    },
  ];
  for (let i = 0; i < tranches; i += 1) {
    agents.push({
      agent: directional({
        id: `ramp-${i}`,
        side: "long",
        notional: 12_000,
        margin: 2_400,
        openAt: 30 + i * 12,
      }),
      collateral: 4_000,
    });
  }
  return {
    name: "funding-curve",
    description:
      "Skew ramps ~0→1 in tranches against a fixed short, tracing the convex funding curve.",
    path: flatPath(blocks, BTC_START), // flat price isolates the funding curve from price noise
    // Large pool so the ramp never hits the OI cap (this probe is about the curve, not the cap).
    pool: { capital: 10_000_000, gapFund: 50_000 },
    agents,
  };
}

/** 7. Stress — everything at once over a long run: the integration scenario. */
export function stress(blocks = 1200): Scenario {
  return {
    name: "stress",
    description:
      "Longs + shorts + a skew wave + an MM + a dark agent + a gap, over 1200 blocks — the integration run.",
    path: gbmPath({
      blocks,
      start: BTC_START,
      driftPerBlock: -0.00005,
      volPerBlock: 0.0004,
      seed: 99,
      gaps: [{ at: 800, factor: 0.88 }],
    }),
    pool: { capital: 800_000, gapFund: 30_000 },
    agents: [
      {
        agent: directional({ id: "long-1", side: "long", notional: 80_000, margin: 16_000 }),
        collateral: 40_000,
      },
      {
        agent: directional({ id: "short-1", side: "short", notional: 60_000, margin: 12_000 }),
        collateral: 30_000,
      },
      {
        agent: skewPusher({ id: "wave", notional: 600_000, margin: 90_000, openAt: 100 }),
        collateral: 120_000,
      },
      {
        agent: mmAgent({ id: "mm", notional: 300_000, margin: 60_000, arriveAt: 300 }),
        collateral: 200_000,
      },
      {
        agent: darkAgent({ id: "dark", notional: 80_000, margin: 8_000, goesDarkAt: 400 }),
        collateral: 8_000,
      },
      {
        agent: fundingStrategyAgent({ id: "funding-hero", notional: 60_000, margin: 12_000 }),
        collateral: 60_000,
      },
      {
        agent: gapVictim({ id: "gap-victim", notional: 70_000, margin: 1_400, openAt: 700 }),
        collateral: 1_400,
      },
    ],
  };
}

/** All scenarios, in canonical order, as builder thunks. */
export const SCENARIOS: Record<string, () => Scenario> = {
  "mixed-book": () => mixedBook(),
  "skew-wave": () => skewWave(),
  "dark-decrement": () => darkDecrement(),
  "mm-rebalance": () => mmRebalance(),
  "gap-event": () => gapEvent(),
  "funding-hero": () => fundingHero(),
  "funding-curve": () => fundingCurveProbe(),
  stress: () => stress(),
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
