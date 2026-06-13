/**
 * Phase 1 economic simulation entry point (Doc 2 Phase 1).
 *
 * Will drive the §4.3 per-block loop over thousands of synthetic blocks with the agent
 * scenarios in Doc 2 §1.2 (longs/shorts, a skew-pushing flow, a dark agent, an MM-agent, a
 * gap event), sweeping `{λ, α, r_max, k, m}` and emitting the four "good" criteria (§1.3).
 *
 * Stubbed for Phase 0 so `bun run sim` resolves; the core formulas it will use already live
 * in `../core`.
 */

import { MARKET_SYMBOLS } from "@sidekick/shared";

console.log("[sim] SideKick economic simulation — Phase 1 stub.");
console.log(`[sim] markets: ${MARKET_SYMBOLS.join(", ")}`);
console.log("[sim] Implemented in Phase 1: per-block loop, agent scenarios, constants sweep.");
