// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deployers} from "./Deployers.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {Pool} from "../src/Pool.sol";
import {Position, Side} from "../src/Types.sol";

/// @notice Integration tests for the §4.3 on-chain loop — the load-bearing correctness claims,
///         mirrored from `packages/engine/src/sim/market.test.ts`:
///           - open/close move collateral + pool exposure correctly,
///           - USDC conservation: Σ(claims) == vault token balance every step (funding + decrement
///             neither create nor destroy money; the gap fund is the only sink),
///           - loop ordering (§4.3): health is checked against POST-funding equity,
///           - decrement smoothness: a dark agent trims toward zero, no catastrophic close,
///           - gap branch: E ≤ 0 draws from the gap fund,
///           - Layer-2 OI cap: opens refused as exposure approaches k·capital.
contract PerpEngineTest is Deployers {
    address lpA;
    address long1;
    address short1;
    address dark;

    address[] internal book; // the account set passed to checkpoint()

    function setUp() public {
        lpA = makeAddr("lpA");
        long1 = makeAddr("long1");
        short1 = makeAddr("short1");
        dark = makeAddr("dark");
        _deployVenue();
        _seedPool(lpA, 1_000_000 * USDC, 50_000 * USDC);
    }

    // ── open / close ────────────────────────────────────────────────────────────────

    function test_open_postsMarginAndAbsorbs() public {
        _fund(long1, 50_000 * USDC);
        _open(long1, Side.Long, 100_000 * USDC, 20_000 * USDC, MARK0);

        Position memory p = engine.positionOf(BTC, long1);
        assertEq(uint256(p.side), uint256(Side.Long));
        assertEq(p.entryNotional, 100_000 * USDC);
        assertEq(p.margin, 20_000 * USDC);
        assertEq(vault.freeCollateral(long1), 30_000 * USDC, "margin debited from free collateral");
        // Pool absorbed the short side → net short ~100k.
        assertApproxEqAbs(pool.exposure(MARK0), 100_000 * USDC, 1);
    }

    function test_open_refusedOverOICap() public {
        _fund(long1, 500_000 * USDC);
        // cap = k·capital = 3·1,000,000 = 3,000,000. A 4,000,000 long breaches it.
        vm.prank(long1);
        vm.expectRevert(PerpEngine.OICapExceeded.selector);
        engine.openPosition(BTC, Side.Long, 4_000_000 * USDC, 400_000 * USDC, MARK0);
    }

    function test_close_atEntry_returnsMargin_conserves() public {
        _fund(long1, 50_000 * USDC);
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        _open(long1, Side.Long, 100_000 * USDC, 20_000 * USDC, MARK0);
        vm.prank(long1);
        engine.closePosition(BTC, MARK0); // flat price → no PnL → full margin back
        assertEq(vault.freeCollateral(long1), 50_000 * USDC, "all collateral returned");
        assertEq(uint256(engine.positionOf(BTC, long1).side), uint256(Side.Flat));
        assertEq(usdc.balanceOf(address(vault)), vaultBefore, "vault token balance unchanged");
    }

    function test_close_inProfit_paidFromPool() public {
        _fund(long1, 50_000 * USDC);
        _open(long1, Side.Long, 100_000 * USDC, 20_000 * USDC, MARK0);
        uint256 capBefore = pool.capital();
        // Mark +10% → long gains ~10k, paid out of pool capital on close.
        uint256 markUp = MARK0 * 110 / 100;
        vm.prank(long1);
        engine.closePosition(BTC, markUp);
        assertApproxEqAbs(vault.freeCollateral(long1), 60_000 * USDC, 50 * USDC, "trader +~10k");
        assertApproxEqAbs(pool.capital(), capBefore - 10_000 * USDC, 50 * USDC, "pool -~10k");
    }

    // Regression (review finding, critical): a permissionless UNDERWATER close (equity < 0 at an
    // injected mark) must NOT mint phantom USDC. The pool may only seize the trader's margin; the
    // |equity| beyond that is the trader's loss, not new capital. Σ(claims) stays == custody.
    function test_close_underwater_conservesNoPhantomMint() public {
        _fund(long1, 50_000 * USDC);
        _open(long1, Side.Long, 200_000 * USDC, 20_000 * USDC, MARK0);
        book = [long1, lpA];
        uint256 custody = usdc.balanceOf(address(vault));
        // Mark -20% → -40k on 200k notional vs 20k margin → equity = -20k (underwater).
        vm.prank(long1);
        engine.closePosition(BTC, MARK0 * 80 / 100);
        assertEq(uint256(engine.positionOf(BTC, long1).side), uint256(Side.Flat));
        assertEq(vault.freeCollateral(long1), 30_000 * USDC, "trader keeps only un-utilized collateral");
        assertEq(_totalClaims(book), custody, "no phantom USDC minted on an underwater close");
    }

    // Regression (review finding, critical): a WINNING close whose profit exceeds pool capital must
    // not brick on CapitalUnderflow. The pool pays from capital down to 0, draws the gap fund, and
    // the trader is credited only the cash that existed (the uncovered profit is bad debt).
    function test_close_winningBeyondCapital_doesNotBrick_andConserves() public {
        // Pool seeded at 1M (setUp). A 2M-notional long that doubles gains ~2M > capital.
        _fund(long1, 500_000 * USDC);
        _open(long1, Side.Long, 2_000_000 * USDC, 400_000 * USDC, MARK0);
        book = [long1, lpA];
        uint256 custody = usdc.balanceOf(address(vault));
        vm.prank(long1);
        engine.closePosition(BTC, MARK0 * 200 / 100); // +100% → ~2M profit, pool can't fully cover
        assertEq(uint256(engine.positionOf(BTC, long1).side), uint256(Side.Flat), "closed, not bricked");
        assertEq(pool.capital(), 0, "pool capital fully paid out");
        assertEq(_totalClaims(book), custody, "conserves even when the pool cannot fully pay the winner");
    }

    // ── §4.3 loop ordering (anti-double-count) ──────────────────────────────────────

    function test_loopOrder_healthCheckedOnPostFundingEquity() public {
        // A single long → S = +1 → rate > 0 → the long PAYS funding. Margin set so the position is
        // healthy pre-funding (E = m·N exactly) but post-funding dips below maintenance → must be
        // called. Pins that check happens AFTER fund. (Mirrors the sim's market.test.ts case.)
        // Fund exactly the margin so NO free collateral remains → cannot answer the call → decrements.
        _fund(long1, 1_000 * USDC);
        // Margin = exactly maintenance for a 100k notional at m=1% → 1,000.
        _open(long1, Side.Long, 100_000 * USDC, 1_000 * USDC, MARK0);
        book = [long1];

        vm.recordLogs();
        engine.checkpoint(BTC, MARK0, book); // flat mark → only funding moves equity

        // Post-funding the long is short by the funding it paid → it decremented (couldn't pay).
        Position memory p = engine.positionOf(BTC, long1);
        assertLt(p.entryNotional, 100_000 * USDC, "decremented because post-funding equity < m*N");
    }

    // ── funding direction + zero-sum ─────────────────────────────────────────────────

    function test_funding_longPays_poolReceives_whenNetLong() public {
        _fund(long1, 50_000 * USDC);
        _open(long1, Side.Long, 100_000 * USDC, 20_000 * USDC, MARK0); // S=+1 → long pays
        book = [long1];

        uint256 capBefore = pool.capital();
        uint256 marginBefore = engine.positionOf(BTC, long1).margin;
        engine.checkpoint(BTC, MARK0, book);

        uint256 marginAfter = engine.positionOf(BTC, long1).margin;
        uint256 capAfter = pool.capital();
        assertLt(marginAfter, marginBefore, "long paid funding (margin down)");
        assertGt(capAfter, capBefore, "pool received funding (capital up)");
        // Zero-sum: what the long lost, the pool gained (within dust).
        assertApproxEqAbs(marginBefore - marginAfter, capAfter - capBefore, 2, "funding is zero-sum");
    }

    // ── USDC conservation across a multi-block run ──────────────────────────────────

    function test_conservation_acrossCheckpoints() public {
        _fund(long1, 40_000 * USDC);
        _fund(short1, 40_000 * USDC);
        _open(long1, Side.Long, 120_000 * USDC, 20_000 * USDC, MARK0);
        _open(short1, Side.Short, 60_000 * USDC, 15_000 * USDC, MARK0);
        book = [long1, short1, lpA];

        uint256 vaultBal = usdc.balanceOf(address(vault));
        // The vault token balance is the ground truth; Σ(claims) must always equal it.
        assertEq(_totalClaims(book), vaultBal, "claims == custody at t0");

        // Walk a price path over several checkpoints; assert conservation each step.
        uint256[5] memory path = [MARK0, MARK0 * 101 / 100, MARK0 * 99 / 100, MARK0 * 103 / 100, MARK0 * 98 / 100];
        for (uint256 i = 0; i < path.length; i++) {
            engine.checkpoint(BTC, path[i], book);
            assertEq(_totalClaims(book), vaultBal, "claims == custody every checkpoint");
        }
    }

    // ── decrement smoothness (dark agent) ───────────────────────────────────────────

    function test_decrement_darkAgentTrimsSmoothly() public {
        // A well-margined long crowd holds the other side; a dark long with no free collateral
        // can only decrement when the mark drifts against it. No single catastrophic close.
        _fund(long1, 300_000 * USDC);
        _open(long1, Side.Long, 200_000 * USDC, 60_000 * USDC, MARK0); // healthy crowd long
        _fund(dark, 10_000 * USDC); // exactly the margin → no buffer left to answer calls
        _open(dark, Side.Long, 100_000 * USDC, 10_000 * USDC, MARK0); // 10x, no buffer
        book = [long1, dark, lpA];

        uint256 vaultBal = usdc.balanceOf(address(vault));
        uint256 prevNotional = engine.positionOf(BTC, dark).entryNotional;
        bool sawDecrement;
        // Drift the mark down ~0.5%/checkpoint so the dark long erodes gradually.
        uint256 mark = MARK0;
        for (uint256 i = 0; i < 30; i++) {
            mark = mark * 995 / 1000;
            engine.checkpoint(BTC, mark, book);
            uint256 n = engine.positionOf(BTC, dark).entryNotional;
            if (n < prevNotional && prevNotional > 0) {
                sawDecrement = true;
                // No single decrement removes more than ~60% of notional (no cliff).
                assertLe((prevNotional - n) * 100 / prevNotional, 60, "no catastrophic single close");
            }
            prevNotional = n;
            assertEq(_totalClaims(book), vaultBal, "conservation holds through decrements");
        }
        assertTrue(sawDecrement, "the dark agent decremented");
        assertLt(engine.positionOf(BTC, dark).entryNotional, 100_000 * USDC, "trended toward zero");
    }

    // ── gap branch (E <= 0 hits the gap fund) ───────────────────────────────────────

    function test_gap_singleBlockJumpDrawsGapFund() public {
        _fund(long1, 300_000 * USDC);
        _open(long1, Side.Long, 200_000 * USDC, 80_000 * USDC, MARK0); // deep buffer, survives
        // Thin 50x long: margin = collateral, nothing to answer calls; a -18% gap pushes E ≤ 0.
        _fund(dark, 2_000 * USDC); // exactly the margin → no buffer
        _open(dark, Side.Long, 100_000 * USDC, 2_000 * USDC, MARK0);
        book = [long1, dark, lpA];

        uint256 vaultBal = usdc.balanceOf(address(vault));
        uint256 gapBefore = pool.gapFund();
        uint256 gapMark = MARK0 * 82 / 100; // -18% in one step
        engine.checkpoint(BTC, gapMark, book);

        // The thin long gapped: position closed, gap fund drawn, conservation intact.
        assertEq(uint256(engine.positionOf(BTC, dark).side), uint256(Side.Flat), "gapped long closed");
        assertLt(pool.gapFund(), gapBefore, "gap fund drawn on E <= 0");
        assertEq(_totalClaims(book), vaultBal, "conservation holds across a gap");
    }

    // ── answerMarginCall (off-chain settlement hook) ────────────────────────────────

    function test_answerMarginCall_topsUpMargin() public {
        _fund(long1, 50_000 * USDC);
        _open(long1, Side.Long, 100_000 * USDC, 20_000 * USDC, MARK0);
        engine.answerMarginCall(BTC, long1, 5_000 * USDC);
        assertEq(engine.positionOf(BTC, long1).margin, 25_000 * USDC);
        assertEq(vault.freeCollateral(long1), 25_000 * USDC);
    }

    // Regression (review finding, low): answerMarginCall reverts on an unknown market (defense-in-depth).
    function test_answerMarginCall_unknownMarket_reverts() public {
        vm.expectRevert(); // MarketNotFound from the registry lookup
        engine.answerMarginCall(bytes32("NOPE"), long1, 1);
    }

    function test_checkpoint_onlyOwner() public {
        book = [long1];
        vm.prank(long1);
        vm.expectRevert();
        engine.checkpoint(BTC, MARK0, book);
    }
}
