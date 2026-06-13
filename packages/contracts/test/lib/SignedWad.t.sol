// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SignedWad} from "../../src/lib/SignedWad.sol";

/// @notice Unit tests for the signed WAD fixed-point primitives.
contract SignedWadTest is Test {
    using SignedWad for int256;

    int256 constant WAD = 1e18;

    // Typed wrappers so the `using` directive applies (literals are int_const, not int256).
    function mul(int256 a, int256 b) internal pure returns (int256) {
        return a.wadMul(b);
    }

    function div(int256 a, int256 b) internal pure returns (int256) {
        return a.wadDiv(b);
    }

    function test_wadMul_basic() public pure {
        assertEq(mul(2e18, 3e18), 6e18, "2*3=6");
        assertEq(mul(WAD, 5e18), 5e18, "1*5=5");
        assertEq(mul(0.5e18, 0.5e18), 0.25e18, "0.5*0.5=0.25");
    }

    function test_wadMul_signed() public pure {
        assertEq(mul(-2e18, 3e18), -6e18, "-2*3=-6");
        assertEq(mul(-2e18, -3e18), 6e18, "-2*-3=6");
    }

    function test_wadDiv_basic() public pure {
        assertEq(div(6e18, 3e18), 2e18, "6/3=2");
        assertEq(div(1e18, 4e18), 0.25e18, "1/4=0.25");
    }

    function test_wadDiv_signed() public pure {
        assertEq(div(-6e18, 3e18), -2e18, "-6/3=-2");
        assertEq(div(6e18, -3e18), -2e18, "6/-3=-2");
    }

    function test_wadDiv_byZero_reverts() public {
        vm.expectRevert(SignedWad.DivByZero.selector);
        this.divExternal(1e18, 0);
    }

    function divExternal(int256 a, int256 b) external pure returns (int256) {
        return a.wadDiv(b);
    }

    function test_abs() public pure {
        assertEq(SignedWad.abs(-5e18), 5e18);
        assertEq(SignedWad.abs(5e18), 5e18);
        assertEq(SignedWad.abs(0), 0);
    }

    function test_clamp() public pure {
        assertEq(SignedWad.clamp(5e18, -1e18, 1e18), 1e18, "above hi -> hi");
        assertEq(SignedWad.clamp(-5e18, -1e18, 1e18), -1e18, "below lo -> lo");
        assertEq(SignedWad.clamp(0.3e18, -1e18, 1e18), 0.3e18, "inside -> x");
    }

    /// @dev mul then div by the same WAD value is identity up to truncation dust. Two truncations
    ///      compound, each losing < 1 ulp of the post-scale value, so the recovered error is bounded
    ///      by roughly (b/WAD + 1) ulps. Operands are bounded to realistic venue magnitudes.
    function testFuzz_mulDiv_roundtrip(int256 a, int256 b) public pure {
        a = bound(a, -1e24, 1e24);
        b = bound(b, WAD, 1e24); // multiplier ≥ 1.0; below 1.0 the mul truncation dominates (expected)
        int256 r = div(mul(a, b), b);
        int256 diff = r - a;
        if (diff < 0) diff = -diff;
        int256 tol = b / WAD + 2; // mul truncates < 1 ulp of (a·b); div re-scales it by ~b/WAD
        assertLe(diff, tol, "mul/div roundtrip within truncation bound");
    }
}
