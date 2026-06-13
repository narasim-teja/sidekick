/**
 * Tests for the sweep write-back. The cardinal guarantee: it rewrites ONLY the DEFAULT_PARAMS
 * declaration and nothing else (an earlier over-greedy regex once swallowed the file's imports
 * and types — this pins that it can't recur).
 */

import { describe, expect, test } from "bun:test";
import { writeBackParams } from "./writeback.ts";

const META = { scenarios: ["mixed-book", "stress"], score: 0.9 };
const PARAMS = { m: 0.01, alpha: 0.0005, lambda: 0.08, rMax: 0.0005, k: 3 };

describe("writeBackParams (dry run)", () => {
  test("locates the declaration and produces parsable source", async () => {
    const res = await writeBackParams(PARAMS, META, { dryRun: true });
    expect(res.source).toBeDefined();
    const src = res.source!;
    // The new values are present…
    expect(src).toContain("alpha: 0.0005,");
    expect(src).toContain("lambda: 0.08,");
    expect(src).toContain("k: 3,");
    // …and the rest of the file is intact (imports, types, constants, the markets map).
    expect(src).toContain('import type { Hex } from "viem";');
    expect(src).toContain("export const FUNDING_PERIOD_SECONDS");
    expect(src).toContain("export const MARKETS: Record<MarketSymbol, MarketConfig>");
    expect(src).toContain("export function getMarket");
  });

  test("changes exactly one DEFAULT_PARAMS declaration", async () => {
    const res = await writeBackParams(PARAMS, META, { dryRun: true });
    const src = res.source!;
    const decls = src.match(/const DEFAULT_PARAMS: MarketParams = \{/g) ?? [];
    expect(decls.length).toBe(1);
  });
});
