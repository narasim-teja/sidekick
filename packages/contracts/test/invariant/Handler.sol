// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {SideKickUSDC} from "../../src/test/SideKickUSDC.sol";
import {Vault} from "../../src/Vault.sol";
import {Pool} from "../../src/Pool.sol";
import {PerpEngine} from "../../src/PerpEngine.sol";
import {Side} from "../../src/Types.sol";

/// @notice Stateful fuzz handler for the SideKick invariants. The fuzzer drives a small set of
///         actors through random open / close / checkpoint sequences over a bounded random mark
///         path; the invariant suite then asserts the two load-bearing properties hold throughout:
///           1. pool exposure ≤ k · capital (Layer-2 OI cap, Doc 1 §3.3),
///           2. Σ(claims) == vault USDC balance (conservation, Doc 1 §4 / sim invariants.ts).
/// @dev Opens are guarded by the same admission control the engine enforces, so a refused open is a
///      no-op (not a failure). The handler tracks the current mark and a fixed actor set so the
///      invariant contract can recompute claims over exactly the accounts in play.
contract Handler is CommonBase, StdCheats, StdUtils {
    SideKickUSDC public immutable usdc;
    Vault public immutable vault;
    Pool public immutable pool;
    PerpEngine public immutable engine;
    bytes32 public immutable marketId;
    uint256 public immutable k;

    address[] public actors;
    uint256 public mark;

    /// @notice Set true if ANY admitted open ever left exposure > k·capital at its own mark — i.e.
    ///         the admission control was bypassed. Must stay false forever (the real Layer-2
    ///         guarantee: the cap binds at admission; later mark drift carrying it over is expected
    ///         and pulled back by Layer-1 funding, not an admission-control failure).
    bool public admissionBreached;

    // Mark stays in a band around the seed so price PnL is meaningful but never absurd.
    uint256 internal constant MARK_LO = 40_000e18;
    uint256 internal constant MARK_HI = 100_000e18;
    uint256 internal constant USDC = 1e6;

    constructor(
        SideKickUSDC usdc_,
        Vault vault_,
        Pool pool_,
        PerpEngine engine_,
        bytes32 marketId_,
        uint256 k_,
        address[] memory actors_,
        uint256 mark0
    ) {
        usdc = usdc_;
        vault = vault_;
        pool = pool_;
        engine = engine_;
        marketId = marketId_;
        k = k_;
        actors = actors_;
        mark = mark0;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @notice Fund + open a bounded position for a random actor (admission-controlled → may no-op).
    function open(uint256 actorSeed, uint256 sideSeed, uint256 notionalSeed, uint256 marginBps) external {
        address a = _actor(actorSeed);
        if (engine.positionOf(marketId, a).side != Side.Flat) return; // one position per account
        uint256 notional = bound(notionalSeed, 1_000 * USDC, 2_000_000 * USDC);
        // Margin between 2% and 100% of notional (leverage 50x..1x).
        uint256 margin = (notional * bound(marginBps, 200, 10_000)) / 10_000;
        Side side = sideSeed % 2 == 0 ? Side.Long : Side.Short;

        // Pre-check admission so a refused open is a clean skip (mirrors the engine's own guard).
        int256 qty = (int256(notional) * 1e30) / int256(mark);
        if (!pool.admits(side == Side.Long ? -qty : qty, mark, k)) return;

        uint256 exposureBefore = pool.exposure(mark);

        // Fund the actor's free collateral so the margin debit succeeds.
        usdc.mint(a, margin);
        vm.startPrank(a);
        usdc.approve(address(vault), margin);
        vault.deposit(margin);
        engine.openPosition(marketId, side, notional, margin, mark);
        vm.stopPrank();

        // The Layer-2 guarantee: an admitted open never pushes exposure above the cap — it lands
        // within k·capital, OR (if exposure was already over-cap from prior mark drift) it only
        // ever REDUCES exposure (a de-risking trade is always admitted and never makes it worse).
        uint256 exposureAfter = pool.exposure(mark);
        uint256 cap = k * pool.capital();
        if (exposureAfter > cap + 10 && exposureAfter > exposureBefore + 10) admissionBreached = true;
    }

    /// @notice Close a random actor's position (no-op if flat).
    function close(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        if (engine.positionOf(marketId, a).side == Side.Flat) return;
        vm.prank(a);
        engine.closePosition(marketId, mark);
    }

    /// @notice Move the mark within the band and run a checkpoint over all actors (the §4.3 loop).
    function checkpoint(uint256 markSeed) external {
        mark = bound(markSeed, MARK_LO, MARK_HI);
        engine.checkpoint(marketId, mark, actors);
    }

    /// @notice The conservation ground truth: Σ(free collateral + position margin) + pool capital +
    ///         gap fund. Must equal the vault's USDC balance.
    function totalClaims() external view returns (uint256 total) {
        total = pool.capital() + pool.gapFund();
        for (uint256 i = 0; i < actors.length; i++) {
            total += vault.freeCollateral(actors[i]);
            total += engine.positionOf(marketId, actors[i]).margin;
        }
    }
}
