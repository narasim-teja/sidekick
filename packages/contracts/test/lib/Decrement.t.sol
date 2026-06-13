// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Decrement} from "../../src/lib/Decrement.sol";

/// @notice Unit tests for the §4.2 decrement rule + §4.3 health check, pinned to the doc's worked
///         example and the simulation's branches.
contract DecrementTest is Test {
    int256 constant M = 0.01e18; // 1% maintenance
    uint256 constant USDC = 1e6;

    // ── health check ──────────────────────────────────────────────────────────────

    function test_isHealthy_atExactlyMaintenance() public pure {
        // E = m·N exactly → healthy (inclusive).
        uint256 n = 10_000 * USDC;
        int256 e = int256(uint256(100 * USDC)); // 1% of 10k = 100
        assertTrue(Decrement.isHealthy(e, n, M));
    }

    function test_isHealthy_belowMaintenance() public pure {
        uint256 n = 10_000 * USDC;
        assertFalse(Decrement.isHealthy(int256(uint256(99 * USDC)), n, M));
    }

    function test_marginCall_shortfall() public pure {
        uint256 n = 10_000 * USDC;
        // E = 60 → required 100 → call = 40.
        assertEq(Decrement.marginCall(int256(uint256(60 * USDC)), n, M), 40 * USDC);
        // healthy → 0.
        assertEq(Decrement.marginCall(int256(uint256(100 * USDC)), n, M), 0);
    }

    // ── decrement branch (worked example, Doc 1 §4.2) ───────────────────────────────

    function test_applyDecrement_workedExample() public pure {
        // N = $10,000, m = 1% → required $100. Equity erodes to E = $60 → N' = 60/0.01 = $6,000.
        uint256 n = 10_000 * USDC;
        int256 e = int256(uint256(60 * USDC));
        Decrement.Outcome memory o = Decrement.applyDecrement(e, n, M);
        assertEq(uint256(o.kind), uint256(Decrement.Kind.Decrement));
        assertEq(o.newNotional, 6_000 * USDC, "N' = E/m = 6000");
        assertEq(o.closedNotional, 4_000 * USDC, "closed dN = 4000");
        assertEq(o.badDebt, 0);
    }

    function test_applyDecrement_healthy_noop() public pure {
        uint256 n = 10_000 * USDC;
        Decrement.Outcome memory o = Decrement.applyDecrement(int256(uint256(100 * USDC)), n, M);
        assertEq(uint256(o.kind), uint256(Decrement.Kind.Healthy));
        assertEq(o.newNotional, n);
        assertEq(o.closedNotional, 0);
    }

    // ── gap branch (E ≤ 0) ─────────────────────────────────────────────────────────

    function test_applyDecrement_gap_negativeEquity() public pure {
        uint256 n = 10_000 * USDC;
        int256 e = -int256(uint256(500 * USDC)); // E = −$500
        Decrement.Outcome memory o = Decrement.applyDecrement(e, n, M);
        assertEq(uint256(o.kind), uint256(Decrement.Kind.Gap));
        assertEq(o.newNotional, 0);
        assertEq(o.closedNotional, n);
        assertEq(o.badDebt, 500 * USDC, "bad debt = |E|");
    }

    function test_applyDecrement_gap_atZeroEquity() public pure {
        // E = 0 is the gap branch boundary (E ≤ 0 closes fully, zero bad debt).
        uint256 n = 10_000 * USDC;
        Decrement.Outcome memory o = Decrement.applyDecrement(0, n, M);
        assertEq(uint256(o.kind), uint256(Decrement.Kind.Gap));
        assertEq(o.badDebt, 0);
    }

    /// @dev After a decrement, the new position is maintenance-adequate: E ≥ m·N'.
    function testFuzz_decrement_landsAtMaintenance(uint256 equity, uint256 notional) public pure {
        notional = bound(notional, 1 * USDC, 1e12 * USDC);
        uint256 required = (uint256(M) * notional) / 1e18; // m·N
        if (required <= 1) return; // need a usable 0 < E < m·N window
        equity = bound(equity, 1, required - 1); // 0 < E < m·N → Decrement branch
        Decrement.Outcome memory o = Decrement.applyDecrement(int256(equity), notional, M);
        if (o.kind != Decrement.Kind.Decrement) return;
        assertTrue(
            Decrement.isHealthy(int256(equity), o.newNotional, M), "decremented position is maintenance-adequate"
        );
    }
}
