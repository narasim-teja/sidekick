/**
 * Phase 1 economic simulation entry point (Doc 2 Phase 1).
 *
 * A deterministic, in-memory model of one SideKick market: synthetic agents driving the §4.3
 * per-block loop, the §4.1 funding formula, the §4.2 decrement rule, and a pool with the §3.3
 * Layer-1/Layer-2 bounds — run over thousands of blocks. It tunes `{m, α, λ, r_max, k}` before
 * any Solidity is written and doubles as the demo backend / judge evidence.
 *
 * Usage (`bun run sim [command]`):
 *   bun run sim                 # run every scenario, print the report + criteria
 *   bun run sim <scenario>      # run one scenario (see the list it prints on an unknown name)
 *   bun run sim sweep           # grid-sweep {m,α,λ,r_max,k}, print the ranked table + winner
 *   bun run sim sweep --write   # …and write the chosen params back to packages/shared
 *
 * No chain, no Gateway — pure math (Doc 2 Phase 1 is float). Single-threaded by design: the whole
 * sweep is milliseconds of arithmetic, so workers would add complexity for no gain.
 */

import { evaluate } from "./metrics.ts";
import { renderScenario } from "./report.ts";
import { runScenario, SCENARIO_NAMES, SCENARIOS } from "./scenarios.ts";
import { runSweep, type SweepResult, selectBest } from "./sweep.ts";
import { writeBackParams } from "./writeback.ts";

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "sweep") {
    await runSweepCommand(rest.includes("--write"));
    return;
  }

  if (cmd && cmd in SCENARIOS) {
    runScenarios([cmd]);
    return;
  }

  if (cmd) {
    console.error(
      `Unknown scenario "${cmd}". Available: ${SCENARIO_NAMES.join(", ")}, or "sweep".`,
    );
    process.exit(1);
  }

  // Default: run every scenario.
  runScenarios(SCENARIO_NAMES);
}

/** Run the named scenarios, print each report, and summarize pass/fail. */
function runScenarios(names: string[]): void {
  console.log("SideKick — Phase 1 economic simulation (Doc 2 Phase 1)");
  console.log(`scenarios: ${names.join(", ")}`);

  let passed = 0;
  for (const name of names) {
    const build = SCENARIOS[name];
    if (!build) continue; // unreachable: callers pass only known names
    const run = runScenario(build());
    const metrics = evaluate(run);
    console.log(renderScenario(run, metrics));
    if (metrics.pass) passed += 1;
  }

  console.log("");
  console.log("═".repeat(64));
  const ok = passed === names.length;
  console.log(
    `  ${ok ? "✅" : "⚠️ "} ${passed}/${names.length} scenarios pass all applicable criteria`,
  );
  console.log("═".repeat(64));
  if (!ok) process.exit(1);
}

/** Run the grid sweep, print the ranked table + the winner, optionally write it back. */
async function runSweepCommand(write: boolean): Promise<void> {
  console.log("SideKick — Phase 1 constants sweep (Doc 2 Phase 1 deliverable)");
  console.log("Grid-searching {m, α, λ, r_max, k}; scoring against all scenarios…\n");

  const t0 = performance.now();
  const results = runSweep();
  const elapsed = performance.now() - t0;
  const best = selectBest(results);

  console.log(`Evaluated ${results.length} parameter sets in ${elapsed.toFixed(0)}ms.\n`);
  printTopTable(results.slice(0, 12));

  console.log("\nWinner:");
  console.log(formatParams(best));
  console.log("  per-scenario:");
  for (const s of best.perScenario) {
    console.log(`    ${s.pass ? "✅" : "❌"} ${s.scenario.padEnd(16)} score=${s.score.toFixed(3)}`);
  }

  if (!best.invariantHeld) {
    console.error(
      "\n⚠️  Best surviving combo still breaches the pool invariant — NOT writing back.",
    );
    process.exit(1);
  }

  if (write) {
    const meta = { scenarios: SCENARIO_NAMES, score: best.score };
    const res = await writeBackParams(best.params, meta);
    if (res.wrote) {
      console.log(`\n✅ Wrote chosen params to ${res.path}`);
    } else {
      console.error(`\n❌ Write-back failed: ${res.reason}`);
      process.exit(1);
    }
  } else {
    console.log("\n(dry run — pass --write to persist these to packages/shared/src/markets.ts)");
  }
}

function printTopTable(rows: SweepResult[]): void {
  console.log("  rank  α      λ      r_max    k    score   allPass  invariant");
  console.log(`  ${"─".repeat(60)}`);
  rows.forEach((r, i) => {
    const p = r.params;
    console.log(
      `  ${String(i + 1).padEnd(4)}  ${pad(p.alpha)} ${pad(p.lambda)} ${pad(p.rMax)}  ${pad(p.k)}  ${r.score.toFixed(3)}   ${r.allPass ? "yes" : "no "}      ${r.invariantHeld ? "held" : "BREACH"}`,
    );
  });
}

function formatParams(r: SweepResult): string {
  const p = r.params;
  return `  m=${p.m}  α=${p.alpha}  λ=${p.lambda}  r_max=${p.rMax}  k=${p.k}   (blended score ${r.score.toFixed(3)})`;
}

function pad(x: number): string {
  return String(x).padEnd(6);
}

await main();
