// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MarketParams} from "../Types.sol";

/// @title Params — GENERATED. Do not edit by hand.
/// @notice The Phase-1 sweep-selected market parameters, generated from
///         packages/shared/src/markets.ts (DEFAULT_PARAMS) by `bun run gen:params`. This is the
///         single source of truth shared between the off-chain simulation/engine (TypeScript) and
///         the on-chain venue (Solidity): re-run the sweep with --write, then regenerate this file,
///         and the chain and the sim are provably identical.
/// @dev Dimensionless ratios are WAD (1e18); `k` is a plain integer. See markets.ts for the values'
///      provenance (blended score 0.945 across 8 scenarios; α scales with r_max per the Phase-1
///      finding, so saturation sits at S = ±1).
library Params {
    int256 internal constant M = 10000000000000000; // maintenance fraction m = 0.01
    int256 internal constant ALPHA = 500000000000000; // funding scale α = 0.0005
    int256 internal constant LAMBDA = 80000000000000000; // EMA smoothing λ = 0.08
    int256 internal constant R_MAX = 500000000000000; // per-block rate clamp r_max = 0.0005
    uint256 internal constant K = 3; // OI-cap multiplier k = 3

    /// @notice The swept params as a {MarketParams} struct, ready to register a market.
    function defaults() internal pure returns (MarketParams memory) {
        return MarketParams({m: M, alpha: ALPHA, lambda: LAMBDA, rMax: R_MAX, k: K});
    }
}
