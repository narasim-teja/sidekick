/**
 * Constants sweep (Doc 2 Phase 1 deliverable): grid-search `{m, α, λ, r_max, k}`, score each
 * combination against the four "good" criteria (§1.3) across the scenarios, auto-select the
 * best, and write the chosen params back to `packages/shared` (markets.ts).
 *
 * The score for a combo is the mean criterion score across all scenarios, with a HARD gate: any
 * combo that breaches the pool invariant (§3.3 L2) in any scenario is disqualified outright — a
 * venue that can blow past its OI cap is not a candidate regardless of how nice its funding
 * curve looks. Among the survivors, we maximize the blended criterion score, breaking ties
 * toward a lower λ (stronger manipulation resistance) and a lower k (a tighter, safer cap).
 *
 * The sweep is pure in-memory arithmetic — a few hundred combos × a few thousand blocks is
 * milliseconds of single-threaded float math, so no workers/parallelism are warranted (see the
 * package README). Everything is deterministic (seeded price paths) so the chosen params are
 * reproducible run to run.
 */

import type { MarketParams } from "@sidekick/shared";
import { evaluate } from "./metrics.ts";
import { runScenario, SCENARIOS } from "./scenarios.ts";

/** The grid axes. Centered on the Doc 1 §4 defaults; ranges from the doc's stated bands. */
export interface SweepGrid {
  readonly m: number[];
  readonly alpha: number[];
  readonly lambda: number[];
  readonly rMax: number[];
  readonly k: number[];
}

/**
 * The default sweep grid — λ in its 0.1–0.2 band, k as a tight-to-loose cap, etc.
 *
 * Note on α: the funding rate is `clamp(α·S·|S|, ±r_max)`, so the convex region is only visible
 * while `α·S² < r_max`, i.e. up to skew `S* = √(r_max/α)`. For the clamp to act as a *circuit
 * breaker* (engaging only near the skew extremes) rather than the normal operating point, α must
 * be on the order of r_max — NOT O(1). So the grid expresses α as a small multiple of r_max:
 * α = `alphaMult · r_max`. `alphaMult ≈ 1` puts the clamp right at S = ±1 (full convex sweep);
 * larger multiples pull the saturation point inward. See {@link expandGrid}.
 */
export const DEFAULT_GRID: SweepGrid & { alphaMult: number[] } = {
  m: [0.01], // maintenance fraction is a risk policy, held at 1% (the doc's worked example)
  alpha: [], // derived from alphaMult · rMax in expandGrid (kept for the SweepGrid shape)
  alphaMult: [1, 1.5, 2.5, 4],
  lambda: [0.08, 0.12, 0.15, 0.2],
  rMax: [0.0005, 0.001, 0.002],
  k: [3, 5, 8],
};

/** One scored grid point. */
export interface SweepResult {
  readonly params: MarketParams;
  /** Blended mean criterion score across scenarios (higher is better). */
  readonly score: number;
  /** True iff every applicable criterion passed in every scenario. */
  readonly allPass: boolean;
  /** True iff the pool invariant was never breached (the hard gate). */
  readonly invariantHeld: boolean;
  /** Per-scenario pass/score, for the report. */
  readonly perScenario: { scenario: string; pass: boolean; score: number }[];
}

/** Scenarios the sweep scores against (all of them — the constants must be globally good). */
const SWEEP_SCENARIOS = Object.entries(SCENARIOS);

/** Evaluate one parameter set across all sweep scenarios. */
export function scoreParams(params: MarketParams): SweepResult {
  const perScenario: SweepResult["perScenario"] = [];
  let scoreSum = 0;
  let allPass = true;
  let invariantHeld = true;

  for (const [name, build] of SWEEP_SCENARIOS) {
    const run = runScenario(build(), params);
    const metrics = evaluate(run);
    perScenario.push({ scenario: name, pass: metrics.pass, score: metrics.score });
    scoreSum += metrics.score;
    if (!metrics.pass) allPass = false;
    const inv = metrics.criteria.find((c) => c.key === "pool-invariant");
    if (inv && !inv.pass) invariantHeld = false;
  }

  return {
    params,
    score: scoreSum / SWEEP_SCENARIOS.length,
    allPass,
    invariantHeld,
    perScenario,
  };
}

/** Expand the grid into concrete {@link MarketParams} combos (α = alphaMult · r_max). */
export function expandGrid(
  grid: SweepGrid & { alphaMult?: number[] } = DEFAULT_GRID,
): MarketParams[] {
  const combos: MarketParams[] = [];
  for (const m of grid.m)
    for (const rMax of grid.rMax)
      for (const lambda of grid.lambda)
        for (const k of grid.k) {
          // α from explicit values and/or multiples of r_max (the meaningful scale).
          const alphas = [...grid.alpha, ...(grid.alphaMult ?? []).map((mult) => mult * rMax)];
          for (const alpha of alphas) combos.push({ m, alpha, lambda, rMax, k });
        }
  return combos;
}

/** Run the full grid; returns all results sorted best-first (survivors before disqualified). */
export function runSweep(grid: SweepGrid & { alphaMult?: number[] } = DEFAULT_GRID): SweepResult[] {
  const results = expandGrid(grid).map(scoreParams);
  return results.sort((a, b) => rank(b) - rank(a) || tieBreak(a, b));
}

/** Disqualify invariant-breachers (huge penalty), then rank by blended score. */
function rank(r: SweepResult): number {
  return (r.invariantHeld ? r.score : -1) + (r.allPass ? 0.001 : 0);
}

/** Tie-break toward lower λ (manipulation resistance) then lower k (tighter cap). */
function tieBreak(a: SweepResult, b: SweepResult): number {
  if (a.params.lambda !== b.params.lambda) return a.params.lambda - b.params.lambda;
  return a.params.k - b.params.k;
}

/** Pick the single best parameter set from a sweep. */
export function selectBest(results: SweepResult[]): SweepResult {
  const best = results[0];
  if (!best) throw new Error("sweep produced no results");
  return best;
}
