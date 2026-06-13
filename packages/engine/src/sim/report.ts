/**
 * Console report — renders a {@link ScenarioRun} and its {@link ScenarioMetrics} as a legible
 * per-scenario summary. Console-only output (Phase 1 decision): the four "good" criteria with
 * pass/fail and the numbers, plus a compact per-block sparkline of the load-bearing series so a
 * judge can *see* the funding curve, the bounded pool, and the smooth decrement in the terminal.
 */

import type { BlockState } from "./market.ts";
import type { Criterion, ScenarioMetrics } from "./metrics.ts";
import type { ScenarioRun } from "./scenarios.ts";

const BARS = "▁▂▃▄▅▆▇█";

/** A unicode sparkline of a numeric series, scaled to its own min/max. */
function sparkline(xs: number[], width = 60): string {
  if (xs.length === 0) return "";
  // Downsample to `width` buckets (mean per bucket).
  const step = Math.max(1, Math.floor(xs.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < xs.length; i += step) {
    const slice = xs.slice(i, i + step);
    sampled.push(slice.reduce((p, c) => p + c, 0) / slice.length);
  }
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;
  return sampled
    .map((x) => {
      const idx = Math.min(BARS.length - 1, Math.floor(((x - min) / range) * (BARS.length - 1)));
      return BARS[idx];
    })
    .join("");
}

function check(c: Criterion): string {
  const mark = c.pass ? "✅" : "❌";
  return `  ${mark} ${c.label}\n       ${c.detail}`;
}

/** Render one scenario's full report block to a string. */
export function renderScenario(run: ScenarioRun, metrics: ScenarioMetrics): string {
  const { states, scenario } = run;
  const last = states.at(-1);
  const lines: string[] = [];

  lines.push("");
  lines.push(`━━━ ${scenario.name} ${"━".repeat(Math.max(0, 56 - scenario.name.length))}`);
  lines.push(`  ${scenario.description}`);
  lines.push(
    `  blocks=${states.length}  params: m=${run.params.m} α=${run.params.alpha} λ=${run.params.lambda} r_max=${run.params.rMax} k=${run.params.k}`,
  );
  lines.push("");

  // Sparklines of the load-bearing series.
  const rates = states.map((s) => s.fundingRate);
  const skews = states.map((s) => s.skew);
  const util = states.map((s) => (s.poolCap > 0 ? s.poolExposure / s.poolCap : 0));
  const poolCap = states.map((s) => s.poolCapital);
  lines.push(`  skew  S    ${sparkline(skews)}  [${fmt(min(skews))}, ${fmt(max(skews))}]`);
  lines.push(`  fund  rate ${sparkline(rates)}  [${fmt(min(rates))}, ${fmt(max(rates))}]`);
  lines.push(`  pool  util ${sparkline(util)}  peak ${(max(util) * 100).toFixed(1)}% of cap`);
  lines.push(
    `  pool  cap  ${sparkline(poolCap)}  $${fmtUsd(poolCap[0] ?? 0)} → $${fmtUsd(last?.poolCapital ?? 0)}`,
  );

  // Dark-agent decrement trajectory, if present.
  const darkSeries = darkNotional(states);
  if (darkSeries.length > 0) {
    lines.push(
      `  dark  N    ${sparkline(darkSeries)}  $${fmtUsd(darkSeries[0] ?? 0)} → $${fmtUsd(darkSeries.at(-1) ?? 0)} (smooth decrement)`,
    );
  }

  lines.push("");
  lines.push("  Criteria (Doc 2 §1.3):");
  for (const c of metrics.criteria) lines.push(check(c));
  lines.push("");
  const verdict = metrics.pass ? "✅ PASS" : "❌ FAIL";
  lines.push(
    `  ${verdict}   score=${metrics.score.toFixed(3)}   gap fund: $${fmtUsd(states[0]?.gapFund ?? 0)} → $${fmtUsd(last?.gapFund ?? 0)}`,
  );
  return lines.join("\n");
}

/** The dark agent's per-block notional (post-decrement), for the trajectory sparkline. */
function darkNotional(states: BlockState[]): number[] {
  const series: number[] = [];
  for (const s of states) {
    const e = s.events.find((ev) => ev.accountId.includes("dark"));
    if (e) series.push(e.notionalAfter);
  }
  return series;
}

function min(xs: number[]): number {
  return xs.length ? Math.min(...xs) : 0;
}
function max(xs: number[]): number {
  return xs.length ? Math.max(...xs) : 0;
}
function fmt(x: number): string {
  if (Math.abs(x) < 1e-4 && x !== 0) return x.toExponential(2);
  return x.toFixed(4);
}
function fmtUsd(x: number): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
