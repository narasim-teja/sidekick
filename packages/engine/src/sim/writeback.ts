/**
 * Write the sweep-selected `{m, α, λ, r_max, k}` back to `packages/shared/src/markets.ts`
 * (Doc 2 Phase 1 deliverable: "a constants sweep producing chosen {λ,α,r_max,k,m} per market,
 * written back to packages/shared").
 *
 * All five markets share `DEFAULT_PARAMS`, so we rewrite that single literal — updating every
 * market at once. The rewrite replaces ONLY the `const DEFAULT_PARAMS: MarketParams = { … };`
 * declaration statement (the smallest possible match — never the surrounding doc comment), so it
 * is surgical and idempotent: re-running the sweep overwrites the same five fields cleanly and
 * leaves the rest of the file byte-for-byte intact. Per-market differentiation is a later
 * refinement once real per-asset oracle volatility is available; until then one globally-good set
 * is the honest output.
 */

import { resolve } from "node:path";
import type { MarketParams } from "@sidekick/shared";

/** Resolve markets.ts relative to this file (…/engine/src/sim → …/shared/src). */
function marketsFilePath(): string {
  return resolve(import.meta.dir, "../../../shared/src/markets.ts");
}

/**
 * Match the `DEFAULT_PARAMS` declaration only — from `const DEFAULT_PARAMS` to the closing `};`.
 * Non-greedy body, anchored on the exact identifier + type, so it can match neither the doc
 * comment above it nor anything else in the file. The `m` flag is not needed; `[\s\S]` spans
 * newlines explicitly.
 */
const DECL_RE = /const DEFAULT_PARAMS: MarketParams = \{[\s\S]*?\n\};/;

/** Render just the declaration statement (the doc comment above it is preserved untouched). */
function renderDecl(p: MarketParams, meta: { scenarios: string[]; score: number }): string {
  return [
    `const DEFAULT_PARAMS: MarketParams = {`,
    `  // sweep-selected — blended score ${meta.score.toFixed(3)} across ${meta.scenarios.length} scenarios (see comment above).`,
    `  m: ${p.m},`,
    `  alpha: ${p.alpha},`,
    `  lambda: ${p.lambda},`,
    `  rMax: ${p.rMax},`,
    `  k: ${p.k},`,
    `};`,
  ].join("\n");
}

/** Result of a write-back attempt. */
export interface WriteBackResult {
  readonly path: string;
  readonly wrote: boolean;
  readonly reason?: string;
  /** The rewritten source (always returned, even on dry run, for tests/inspection). */
  readonly source?: string;
}

/**
 * Write `params` into markets.ts. Returns `{ wrote: false }` with a reason if the declaration
 * cannot be located OR if the rewrite would change more than the declaration (a guard against a
 * runaway match), so a failed/over-broad write-back is loud, not silent. `dryRun` returns the
 * rewritten source without touching disk.
 */
export async function writeBackParams(
  params: MarketParams,
  meta: { scenarios: string[]; score: number },
  opts: { dryRun?: boolean } = {},
): Promise<WriteBackResult> {
  const path = marketsFilePath();
  const src = await Bun.file(path).text();

  const match = src.match(DECL_RE);
  if (!match) {
    return { path, wrote: false, reason: "could not locate the DEFAULT_PARAMS declaration" };
  }

  const decl = renderDecl(params, meta);
  const next = src.replace(DECL_RE, decl);

  // Guard: the edit must only touch the declaration. The byte delta should equal the length
  // delta between the old and new declaration — anything else means the regex over-matched.
  const expectedDelta = decl.length - match[0].length;
  if (next.length - src.length !== expectedDelta) {
    return {
      path,
      wrote: false,
      reason: "rewrite would change more than the declaration — aborted",
    };
  }

  if (opts.dryRun) return { path, wrote: false, source: next };
  await Bun.write(path, next);
  return { path, wrote: true, source: next };
}
