/**
 * gen-params — generate `src/generated/Params.sol` from the Phase-1 swept constants in
 * `@sidekick/shared`, so the Solidity deploy uses the SAME values as the simulation with NO manual
 * duplication. Re-run after `bun run sim sweep --write` changes the constants.
 *
 *   bun run gen:params      # writes src/generated/Params.sol
 *
 * The shared package stores the params as floats (the sim is float). On-chain the convention is:
 *   - dimensionless ratios (m, α, λ, r_max) → WAD 1e18 fixed point
 *   - k (OI-cap multiplier) → a plain integer
 * This script does that scaling deterministically and emits Solidity constants the deploy imports.
 * One source of truth (markets.ts) → generated Params.sol → Deploy.s.sol.
 *
 * @see packages/shared/src/markets.ts (DEFAULT_PARAMS, the source)
 * @see packages/contracts/script/Deploy.s.sol (imports the generated constants)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMarket, type MarketParams } from "@sidekick/shared";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "src", "generated", "Params.sol");

/** Scale a float ratio to a WAD (1e18) integer literal, exactly (no binary-float dust in output). */
function toWad(x: number): string {
  // The sweep's constants are short decimals (≤ ~6 sig figs), but IEEE-754 can't represent e.g.
  // 0.08 exactly, so toFixed(18) leaks dust at the 17th place. Round to 12 decimals first — far
  // beyond the sweep's precision, far inside WAD — to recover the intended exact value, then scale.
  const neg = x < 0;
  const [intPart, fracPartRaw = ""] = Math.abs(x).toFixed(12).split(".");
  const frac = fracPartRaw.padEnd(18, "0").slice(0, 18);
  const wad = BigInt(intPart) * 10n ** 18n + BigInt(frac);
  return (neg ? -wad : wad).toString();
}

/**
 * Emit the Solidity file. We generate from the BTC market's params; the Phase-1 sweep selected one
 * blended parameter set shared across all five markets (per-market differentiation is a later
 * refinement once per-asset oracle volatility is available — see markets.ts), so a single constant
 * block is the faithful representation. If markets later diverge, extend this to a per-market struct.
 */
function generate(): string {
  const p: MarketParams = getMarket("BTC-PERP").params;

  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MarketParams} from "../Types.sol";

/// @title Params — GENERATED. Do not edit by hand.
/// @notice The Phase-1 sweep-selected market parameters, generated from
///         packages/shared/src/markets.ts (DEFAULT_PARAMS) by \`bun run gen:params\`. This is the
///         single source of truth shared between the off-chain simulation/engine (TypeScript) and
///         the on-chain venue (Solidity): re-run the sweep with --write, then regenerate this file,
///         and the chain and the sim are provably identical.
/// @dev Dimensionless ratios are WAD (1e18); \`k\` is a plain integer. See markets.ts for the values'
///      provenance (blended score 0.945 across 8 scenarios; α scales with r_max per the Phase-1
///      finding, so saturation sits at S = ±1).
library Params {
    int256 internal constant M = ${toWad(p.m)}; // maintenance fraction m = ${p.m}
    int256 internal constant ALPHA = ${toWad(p.alpha)}; // funding scale α = ${p.alpha}
    int256 internal constant LAMBDA = ${toWad(p.lambda)}; // EMA smoothing λ = ${p.lambda}
    int256 internal constant R_MAX = ${toWad(p.rMax)}; // per-block rate clamp r_max = ${p.rMax}
    uint256 internal constant K = ${p.k}; // OI-cap multiplier k = ${p.k}

    /// @notice The swept params as a {MarketParams} struct, ready to register a market.
    function defaults() internal pure returns (MarketParams memory) {
        return MarketParams({m: M, alpha: ALPHA, lambda: LAMBDA, rMax: R_MAX, k: K});
    }
}
`;
}

const content = generate();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, content);
console.log(`Generated ${OUT}`);
console.log(content);
