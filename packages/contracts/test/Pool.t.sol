// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deployers} from "./Deployers.sol";
import {Pool} from "../src/Pool.sol";
import {LPToken} from "../src/LPToken.sol";
import {Side} from "../src/Types.sol";

/// @notice Pool tests: LP share mint/burn (pro-rata), gap-fund seeding, the Layer-2 OI-cap
///         admission logic, and exposure/PnL marking. The §4.3-loop interaction is covered in
///         PerpEngine.t.sol; here the pool is exercised directly + via opens.
contract PoolTest is Deployers {
    address lpA = address(0x1A);
    address lpB = address(0x1B);
    address trader = address(0x7AD);

    function setUp() public {
        _deployVenue();
    }

    // ── LP shares ─────────────────────────────────────────────────────────────────

    function test_provideLiquidity_genesisMints1to1() public {
        _fund(lpA, 1_000_000 * USDC);
        vm.prank(lpA);
        uint256 shares = pool.provideLiquidity(1_000_000 * USDC);
        assertEq(shares, 1_000_000 * USDC, "genesis 1:1");
        assertEq(lp.balanceOf(lpA), 1_000_000 * USDC);
        assertEq(pool.capital(), 1_000_000 * USDC);
    }

    function test_provideLiquidity_secondLPProRata() public {
        _fund(lpA, 1_000_000 * USDC);
        _fund(lpB, 500_000 * USDC);
        vm.prank(lpA);
        pool.provideLiquidity(1_000_000 * USDC);
        vm.prank(lpB);
        uint256 sharesB = pool.provideLiquidity(500_000 * USDC);
        // No PnL yet → capital == supply, so B gets shares == amount.
        assertEq(sharesB, 500_000 * USDC, "pro-rata at 1:1 capital");
        assertEq(pool.capital(), 1_500_000 * USDC);
    }

    function test_withdrawLiquidity_returnsCapitalToFreeCollateral() public {
        _fund(lpA, 1_000_000 * USDC);
        vm.startPrank(lpA);
        pool.provideLiquidity(1_000_000 * USDC);
        // No open positions → pool equity == capital → full pro-rata withdrawal.
        uint256 amount = pool.withdrawLiquidity(400_000 * USDC, MARK0);
        vm.stopPrank();
        assertEq(amount, 400_000 * USDC);
        assertEq(pool.capital(), 600_000 * USDC);
        assertEq(vault.freeCollateral(lpA), 400_000 * USDC, "credited back to free collateral");
        assertEq(lp.balanceOf(lpA), 600_000 * USDC);
    }

    // Regression (review finding, high): an LP must NOT be able to withdraw capital that is backing
    // winning traders' open profit. With the pool underwater on a long's gain, the per-share payout
    // is gated on pool EQUITY (capital + pricePnl), so the withdrawal is throttled.
    function test_withdrawLiquidity_gatedWhenPoolUnderwater() public {
        _fund(lpA, 1_000_000 * USDC);
        vm.prank(lpA);
        pool.provideLiquidity(1_000_000 * USDC);
        // A trader opens a long → pool net short. Mark up 30% → pool unrealized loss ~30% of exposure.
        _fund(trader, 200_000 * USDC);
        _open(trader, Side.Long, 500_000 * USDC, 100_000 * USDC, MARK0); // pool short 500k
        uint256 upMark = MARK0 * 130 / 100; // pool loses ~150k unrealized
        // Pool equity at upMark ~= 1,000,000 - 150,000 = 850,000. A full-share withdraw is capped to that.
        int256 eq = pool.equity(upMark);
        assertLt(eq, int256(uint256(pool.capital())), "pool equity below raw capital while underwater");
        vm.prank(lpA);
        uint256 amount = pool.withdrawLiquidity(1_000_000 * USDC, upMark); // redeem ALL shares
        // Got equity-value (~850k), NOT the full 1M capital — the ~150k backing the winner stays.
        assertApproxEqAbs(amount, uint256(eq), 1_000 * USDC, "withdrawal gated to pool equity, not raw capital");
        assertLt(amount, 1_000_000 * USDC, "could not extract capital backing the winning trader");
    }

    function test_lpToken_onlyPoolCanMint() public {
        vm.prank(trader);
        vm.expectRevert(LPToken.OnlyPool.selector);
        lp.mint(trader, 1);
    }

    // Regression (review finding, medium): a deposit too small to mint even one share must revert,
    // not silently gift `amount` to existing LPs for zero claim. We engineer capital-per-share > 1
    // by having a trader close at a LOSS to the pool (capital grows while LP supply stays fixed),
    // then a sub-share deposit rounds to 0.
    function test_provideLiquidity_zeroShares_reverts() public {
        _fund(lpA, 1_000_000 * USDC);
        vm.prank(lpA);
        pool.provideLiquidity(1_000_000 * USDC); // supply = 1,000,000e6

        // A trader opens then closes underwater so the pool keeps the loss → capital > supply.
        _fund(trader, 1_000_000 * USDC);
        _open(trader, Side.Long, 500_000 * USDC, 400_000 * USDC, MARK0);
        vm.prank(trader);
        engine.closePosition(BTC, MARK0 * 50 / 100); // -50% → pool gains ~250k; capital now > supply

        assertGt(pool.capital(), lp.totalSupply(), "capital-per-share > 1");
        // A 1-atomic-unit deposit now rounds to 0 shares → must revert ZeroShares.
        _fund(lpA, 1);
        vm.prank(lpA);
        vm.expectRevert(Pool.ZeroShares.selector);
        pool.provideLiquidity(1);
    }

    // ── gap fund ────────────────────────────────────────────────────────────────

    function test_seedGapFund() public {
        _fund(lpA, 50_000 * USDC);
        vm.prank(lpA);
        pool.seedGapFund(50_000 * USDC);
        assertEq(pool.gapFund(), 50_000 * USDC);
        assertEq(vault.freeCollateral(lpA), 0);
    }

    // ── Layer-2 OI cap (admits) ────────────────────────────────────────────────────

    function test_admits_withinCap() public {
        _seedPool(lpA, 300_000 * USDC, 0); // k=3 → cap = 900k
        // A trader long of 500k → pool absorbs short 500k qty; exposure 500k ≤ 900k → admitted.
        int256 qty = _qtyWadLong(500_000 * USDC, MARK0);
        assertTrue(pool.admits(-qty, MARK0, K));
    }

    function test_admits_refusesOverCap() public {
        _seedPool(lpA, 300_000 * USDC, 0); // cap = 900k
        // A trader long of 1,000,000 → pool exposure 1,000,000 > 900,000 → refused.
        int256 qty = _qtyWadLong(1_000_000 * USDC, MARK0);
        assertFalse(pool.admits(-qty, MARK0, K));
    }

    function test_admits_alwaysAllowsDeRisking() public {
        // Build pool net SHORT exposure via a long open, then a trade that reduces |exposure|
        // (toward zero, without overshooting) is admitted even when currently near/over the cap.
        _seedPool(lpA, 300_000 * USDC, 0); // cap = 900k
        _fund(trader, 200_000 * USDC);
        _open(trader, Side.Long, 800_000 * USDC, 150_000 * USDC, MARK0); // pool now net short ~800k
        // A short trader of 400k → pool absorbs +400k long → net short shrinks to ~400k < 800k.
        int256 deRiskDelta = _qtyWadLong(400_000 * USDC, MARK0); // pool-delta is +long qty
        assertTrue(pool.admits(deRiskDelta, MARK0, K), "de-risking trade never blocked");
    }

    // ── exposure / PnL marking ─────────────────────────────────────────────────────

    function test_exposure_and_pricePnl() public {
        _seedPool(lpA, 1_000_000 * USDC, 0);
        _fund(trader, 50_000 * USDC);
        _open(trader, Side.Long, 100_000 * USDC, 20_000 * USDC, MARK0); // pool net SHORT 100k
        // Within 1 atomic-USDC of 100k (entry-notional → qty round-trip truncates by ≤ 1 unit).
        assertApproxEqAbs(pool.exposure(MARK0), 100_000 * USDC, 1, "exposure = |netQty|*mark");
        // Mark up 10% → trader long gains, pool (short) loses ~10k.
        uint256 markUp = MARK0 * 110 / 100;
        int256 pnl = pool.pricePnl(markUp);
        assertApproxEqAbs(pnl, -int256(uint256(10_000 * USDC)), 5 * USDC, "pool short loses ~10k on +10%");
    }

    function test_engineGated_absorb() public {
        // Direct absorb by a non-engine reverts.
        vm.prank(trader);
        vm.expectRevert(Pool.OnlyEngine.selector);
        pool.absorb(1e18, MARK0);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

    /// @dev Mirror PerpEngine._qtyWad for a long (notional 6dp, mark 18dp) → qty WAD.
    function _qtyWadLong(uint256 notional, uint256 mark) internal pure returns (int256) {
        return (int256(notional) * 1e30) / int256(mark);
    }
}
