// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Funding} from "../../src/lib/Funding.sol";

/// @notice Unit tests for the §4.1 funding math, pinned to the simulation's formulas + the
///         Phase-1 swept params (alpha = rMax = 0.0005, lambda = 0.08).
contract FundingTest is Test {
    int256 constant WAD = 1e18;
    int256 constant ALPHA = 0.0005e18;
    int256 constant R_MAX = 0.0005e18;
    int256 constant LAMBDA = 0.08e18;
    uint256 constant USDC = 1e6;

    function _params() internal pure returns (Funding.Params memory) {
        return Funding.Params({alpha: ALPHA, rMax: R_MAX, lambda: LAMBDA});
    }

    // ── skew ────────────────────────────────────────────────────────────────────────

    function test_skew_balanced_isZero() public pure {
        assertEq(Funding.skew(100_000 * USDC, 100_000 * USDC), 0);
    }

    function test_skew_noOI_isZero() public pure {
        assertEq(Funding.skew(0, 0), 0);
    }

    function test_skew_allLong_isOne() public pure {
        assertEq(Funding.skew(100_000 * USDC, 0), WAD, "S = +1");
    }

    function test_skew_allShort_isNegOne() public pure {
        assertEq(Funding.skew(0, 100_000 * USDC), -WAD, "S = -1");
    }

    function test_skew_partial() public pure {
        // (150 − 50)/(150 + 50) = 100/200 = 0.5
        assertEq(Funding.skew(150_000 * USDC, 50_000 * USDC), 0.5e18);
    }

    // ── EMA smoothing ─────────────────────────────────────────────────────────────

    function test_smoothSkew_step() public pure {
        // S_smooth = λ·S + (1−λ)·prev; λ=0.08, S=1, prev=0 → 0.08
        assertEq(Funding.smoothSkew(WAD, 0, LAMBDA), 0.08e18);
        // next step from prev=0.08, S=1 → 0.08 + 0.92·0.08 = 0.1536
        assertEq(Funding.smoothSkew(WAD, 0.08e18, LAMBDA), 0.1536e18);
    }

    // ── convex, clamped rate ────────────────────────────────────────────────────────

    function test_fundingRate_atSaturation_isRMax() public pure {
        // S_smooth = 1 → α·1·1 = α = rMax (alpha scales with rMax) → exactly rMax.
        assertEq(Funding.fundingRate(WAD, _params()), R_MAX, "rate at S=1 equals rMax");
        assertEq(Funding.fundingRate(-WAD, _params()), -R_MAX, "rate at S=-1 equals -rMax");
    }

    function test_fundingRate_convexShape() public pure {
        // At S = 0.5: α·0.5·0.5 = α·0.25 = 0.0005·0.25 = 0.000125.
        assertEq(Funding.fundingRate(0.5e18, _params()), 0.000125e18, "convex S*|S|");
        // Flat near balance: at S = 0.1, rate = α·0.01 = 0.000005 (tiny).
        assertEq(Funding.fundingRate(0.1e18, _params()), 0.000005e18);
    }

    function test_fundingRate_clampEngagesBeyondSaturation() public pure {
        // Past S=1 (only reachable if α>rMax; here equal) the clamp holds it at rMax — assert with a
        // bumped alpha so raw would exceed rMax and the clamp must bite.
        Funding.Params memory p = Funding.Params({alpha: 0.002e18, rMax: R_MAX, lambda: LAMBDA});
        // raw at S=1 = 0.002 > rMax=0.0005 → clamped.
        assertEq(Funding.fundingRate(WAD, p), R_MAX, "clamp engages");
    }

    // ── per-block payment ─────────────────────────────────────────────────────────

    function test_fundingPayment_knownValue() public pure {
        // N = 100k USDC, rate = rMax = 0.0005, Δt/T = 2/28800.
        // payment = 100000·0.0005·(2/28800) = 50·(2/28800) = 0.00347222 USDC = 3472 (6dp, truncated).
        int256 pay = Funding.fundingPayment(100_000 * USDC, R_MAX, 2, 8 hours);
        assertEq(pay, 3472, "100k @ rMax for one 2s block ~ 0.00347 USDC");
    }

    function test_fundingPayment_zeroRate_isZero() public pure {
        assertEq(Funding.fundingPayment(100_000 * USDC, 0, 2, 8 hours), 0);
    }

    function test_fundingPayment_scalesWithNotional() public pure {
        // Linear in notional up to fixed-point truncation dust (10x the smaller, within a few ulps).
        int256 small = Funding.fundingPayment(10_000 * USDC, R_MAX, 2, 8 hours);
        int256 big = Funding.fundingPayment(100_000 * USDC, R_MAX, 2, 8 hours);
        int256 diff = big - small * 10;
        if (diff < 0) diff = -diff;
        assertLe(diff, 10, "linear in notional within truncation dust");
    }
}
