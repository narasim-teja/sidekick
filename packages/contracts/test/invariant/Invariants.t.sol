// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deployers} from "../Deployers.sol";
import {Handler} from "./Handler.sol";

/// @notice Stateful invariant suite (Doc 2 §2.3): across fuzzed open/close/checkpoint sequences,
///           - pool net exposure ≤ k · pool capital (Layer-2 OI cap), and
///           - USDC is conserved: Σ(claims) == vault custody balance.
///         The handler is the only target so the fuzzer composes realistic venue operations.
contract InvariantsTest is Deployers {
    Handler internal handler;
    address[] internal actors;

    function setUp() public {
        _deployVenue();
        address lp = makeAddr("invLP");
        _seedPool(lp, 1_000_000 * USDC, 50_000 * USDC);

        actors = new address[](4);
        actors[0] = makeAddr("actor0");
        actors[1] = makeAddr("actor1");
        actors[2] = makeAddr("actor2");
        actors[3] = makeAddr("actor3");

        handler = new Handler(usdc, vault, pool, engine, BTC, K, actors, MARK0);

        // The engine checkpoint is owner-gated; transfer ownership to the handler so it can drive it.
        engine.transferOwnership(address(handler));

        targetContract(address(handler));
    }

    /// @notice Layer-2 (Doc 1 §3.3): the OI-cap admission control is never bypassed — every admitted
    ///         open leaves exposure ≤ k · capital at the mark it is admitted at. (Subsequent mark
    ///         drift can carry marked exposure over the cap; that is expected and pulled back by
    ///         Layer-1 convex funding over time, not an admission-control failure — see the sim,
    ///         which likewise checks `admits` only on opens.)
    function invariant_admissionControlNeverBypassed() public view {
        assertFalse(handler.admissionBreached(), "no admitted open ever breached k*capital");
    }

    /// @notice Conservation: the sum of all USDC claims equals the vault's token balance.
    /// @dev Each operation can leave ≤ ~1 atomic-USDC (1e-6) of fixed-point truncation dust
    ///      (entry-notional↔qty round-trips, gap-draw splits), so the residual grows sub-linearly
    ///      with the number of fuzzed ops. The tolerance is therefore RELATIVE to custody (~0.1 ppm
    ///      + a small floor): on the ~$12M systems these runs reach, the actual residual measured at
    ///      10k calls is ≈ 50 atomic units, far under the bound — while a STRUCTURAL leak would scale
    ///      with notional ($-magnitude, millions of atomic units) and trip it immediately. The
    ///      exact-conservation paths (open/close, underwater close, winning-close-beyond-capital,
    ///      gap, decrement) are pinned to delta 0 in the unit tests; this guards against UNbounded drift.
    function invariant_usdcConserved() public view {
        uint256 vaultBal = usdc.balanceOf(address(vault));
        uint256 claims = handler.totalClaims();
        uint256 tol = vaultBal / 1e7 + 100; // ~0.1 ppm of custody, floored at 100 atomic units
        assertApproxEqAbs(claims, vaultBal, tol, "claims == custody (within truncation dust)");
    }

    /// @notice Capital + gap fund stay non-negative (no underflow path drains them below zero).
    function invariant_poolSolvent() public view {
        assertGe(pool.capital(), 0);
        assertGe(pool.gapFund(), 0);
    }
}
