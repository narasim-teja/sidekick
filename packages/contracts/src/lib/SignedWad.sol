// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SignedWad — signed 18-decimal fixed-point math for SideKick.
/// @notice The on-chain port of the Phase-1 simulation keeps two units (Doc 2 Phase 2 note):
///         USDC amounts in 6-decimal atomic integers, and *dimensionless* quantities
///         (skew, funding rate, the params m/α/λ/k) plus the mark price in WAD (1e18) fixed
///         point. This library is the signed WAD arithmetic those dimensionless terms need —
///         funding and PnL are signed, so `int256` is the working type. Amounts that are
///         always non-negative (a margin, a notional) are passed as `int256` here only where
///         they mix with a signed term; pure USDC bookkeeping stays in the venue contracts.
/// @dev    Mirrors the float operations in `packages/engine/src/core` exactly: `wadMul`/`wadDiv`
///         are the fixed-point analogue of `*` and `/`, `clamp` is the funding-rate clamp, and
///         `abs` backs the convex `S·|S|` shape. Rounding is truncation toward zero (Solidity's
///         native integer-division behaviour), matching the simulation to within fixed-point
///         dust — the conservation tests assert the residual stays negligible.
library SignedWad {
    /// @notice 1.0 in WAD fixed point.
    int256 internal constant WAD = 1e18;

    /// @notice Thrown when a `wadDiv` denominator is zero.
    error DivByZero();

    /// @notice Absolute value of a signed WAD (or any int256). Reverts on `type(int256).min`
    ///         (its magnitude is unrepresentable) — never reachable with real venue magnitudes.
    function abs(int256 a) internal pure returns (int256) {
        return a >= 0 ? a : -a;
    }

    /// @notice Signed multiply in WAD: (a · b) / 1e18, truncated toward zero.
    /// @dev `a * b` is checked (0.8.x reverts on overflow); the division re-scales out the WAD.
    function wadMul(int256 a, int256 b) internal pure returns (int256) {
        return (a * b) / WAD;
    }

    /// @notice Signed divide in WAD: (a · 1e18) / b, truncated toward zero.
    function wadDiv(int256 a, int256 b) internal pure returns (int256) {
        if (b == 0) revert DivByZero();
        return (a * WAD) / b;
    }

    /// @notice Clamp `x` into the inclusive range [lo, hi]. Requires lo ≤ hi (caller guarantees;
    ///         SideKick always calls it as `clamp(x, -rMax, rMax)` with rMax ≥ 0).
    function clamp(int256 x, int256 lo, int256 hi) internal pure returns (int256) {
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }

    /// @notice Larger of two signed values.
    function max(int256 a, int256 b) internal pure returns (int256) {
        return a >= b ? a : b;
    }

    /// @notice Smaller of two signed values.
    function min(int256 a, int256 b) internal pure returns (int256) {
        return a <= b ? a : b;
    }
}
