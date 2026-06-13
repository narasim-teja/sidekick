// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SignedWad} from "./SignedWad.sol";

/// @title Decrement — the §4.2 decrement rule + §4.3 health check, ported from
///        `packages/engine/src/core/decrement.ts`.
/// @notice On the no-pay path (β = 1, full restore each block):
///
///   if E ≥ m·N:   healthy — do nothing
///   elif E > 0:   N' = E / m            // shrink to maintenance-adequate at mark
///                 ΔN = N − N'           // closed against the pool at current mark
///   else (E ≤ 0): close fully; draw |E| from the gap fund   // the only place bad debt enters
///
/// @dev Units: equity E and notional N in USDC 6dp; maintenance fraction `m` in WAD.
///      `m·N` is `wadMul(m, N)` (→ 6dp); `N' = E/m` is `wadDiv(E, m)` (→ 6dp). The library is pure
///      arithmetic over the post-funding equity — the caller (PerpEngine) owns the §4.3 ordering
///      and only invokes {applyDecrement} after the margin call went unpaid.
library Decrement {
    using SignedWad for int256;

    /// @notice Outcome kind for one position's reconciliation, matching the sim's `ReconcileOutcome`.
    enum Kind {
        Healthy, // E ≥ m·N
        Decrement, // 0 < E < m·N → shrink to N' = E/m
        Gap // E ≤ 0 → close fully, |E| is bad debt

    }

    /// @notice The result of {applyDecrement}. `newNotional`/`closedNotional` are set on Decrement;
    ///         `badDebt` is set on Gap; all are USDC 6dp.
    struct Outcome {
        Kind kind;
        uint256 newNotional;
        uint256 closedNotional;
        uint256 badDebt;
    }

    /// @notice A position is healthy iff equity ≥ m · notional. `m` WAD, equity/notional 6dp.
    function isHealthy(int256 equity, uint256 notional, int256 m) internal pure returns (bool) {
        int256 required = m.wadMul(int256(notional)); // m·N in 6dp
        return equity >= required;
    }

    /// @notice The margin-call amount needed to restore health: max(0, m·N − E), in USDC 6dp.
    function marginCall(int256 equity, uint256 notional, int256 m) internal pure returns (uint256) {
        int256 required = m.wadMul(int256(notional));
        int256 shortfall = required - equity;
        return shortfall > 0 ? uint256(shortfall) : 0;
    }

    /// @notice Apply the §4.2 decrement given the POST-funding equity. Does not itself re-check the
    ///         margin call — the caller invokes this only when the position is short and unpaid.
    /// @param equity   Post-funding equity E (USDC 6dp, may be ≤ 0).
    /// @param notional Current notional N (USDC 6dp).
    /// @param m        Maintenance fraction (WAD).
    function applyDecrement(int256 equity, uint256 notional, int256 m) internal pure returns (Outcome memory o) {
        if (isHealthy(equity, notional, m)) {
            return Outcome({kind: Kind.Healthy, newNotional: notional, closedNotional: 0, badDebt: 0});
        }
        if (equity > 0) {
            // N' = E / m (→ 6dp). ΔN = N − N' is the slice force-closed against the pool at mark.
            uint256 newNotional = uint256(equity.wadDiv(m));
            // Guard the float-dust edge where rounding nudges N' just above N: never grow on a decrement.
            if (newNotional > notional) newNotional = notional;
            return Outcome({
                kind: Kind.Decrement,
                newNotional: newNotional,
                closedNotional: notional - newNotional,
                badDebt: 0
            });
        }
        // E ≤ 0: gap event — close fully, |E| is the bad debt drawn from the gap fund.
        return Outcome({kind: Kind.Gap, newNotional: 0, closedNotional: notional, badDebt: uint256(-equity)});
    }
}
