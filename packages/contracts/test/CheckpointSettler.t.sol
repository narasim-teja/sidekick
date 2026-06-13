// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deployers} from "./Deployers.sol";
import {CheckpointSettler} from "../src/oracle/CheckpointSettler.sol";
import {IReceiver} from "../src/oracle/keystone/IReceiver.sol";
import {Side} from "../src/Types.sol";

/// @title CheckpointSettlerTest — proves the CRE-driven settlement path: a forwarder-delivered report
///        runs a REAL PerpEngine.checkpoint, with the settler as the engine owner. This is what makes
///        CRE the Layer-C settlement orchestrator (not just oracle delivery).
contract CheckpointSettlerTest is Deployers {
    CheckpointSettler internal settler;
    address internal forwarder = address(0xF0);
    address internal lpAddr = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0);

    function setUp() public {
        _deployVenue();

        // Deploy the settler gated to `forwarder`, then hand it the engine's ownership so its
        // checkpoint() call is authorized.
        address[] memory fwds = new address[](1);
        fwds[0] = forwarder;
        settler = new CheckpointSettler(address(engine), fwds, owner);
        engine.transferOwnership(address(settler));

        // Liquidity + two opposing positions so a checkpoint actually moves funding.
        _seedPool(lpAddr, 100_000 * USDC, 1_000 * USDC);
        _fund(alice, 10_000 * USDC);
        _fund(bob, 10_000 * USDC);
        _open(alice, Side.Long, 50_000 * USDC, 1_000 * USDC, MARK0);
        _open(bob, Side.Short, 20_000 * USDC, 1_000 * USDC, MARK0);
    }

    function _report(bytes32 marketId, uint256 mark, address[] memory accts) internal pure returns (bytes memory) {
        return abi.encode(CheckpointSettler.SettleReport({marketId: marketId, mark: mark, accounts: accts}));
    }

    /// The engine now tracks the open-account set on-chain — the workflow reads THIS for the report.
    function test_openAccounts_trackedOnChain() public view {
        address[] memory open = engine.openAccounts(BTC);
        assertEq(open.length, 2);
        assertEq(engine.openAccountCount(BTC), 2);
        // membership (order not guaranteed)
        bool hasA;
        bool hasB;
        for (uint256 i = 0; i < open.length; i++) {
            if (open[i] == alice) hasA = true;
            if (open[i] == bob) hasB = true;
        }
        assertTrue(hasA && hasB);
    }

    function test_onlyForwarderCanSettle() public {
        address[] memory accts = engine.openAccounts(BTC);
        vm.expectRevert(abi.encodeWithSelector(CheckpointSettler.UnauthorizedForwarder.selector, address(this)));
        settler.onReport("", _report(BTC, MARK0, accts));
    }

    /// The headline: a forwarder report drives a real checkpoint (skew net long → longs pay funding).
    function test_forwarderDrivesRealCheckpoint() public {
        uint256 idxBefore = engine.checkpointCount(BTC);
        int256 aliceEqBefore = engine.equityOf(BTC, alice, MARK0);

        address[] memory accts = engine.openAccounts(BTC);
        vm.prank(forwarder);
        settler.onReport("meta", _report(BTC, MARK0, accts));

        // Checkpoint ran: counter advanced, settler counted it, funding moved the net-long side.
        assertEq(engine.checkpointCount(BTC), idxBefore + 1);
        assertEq(settler.settleCount(), 1);
        // Net long (50k vs 20k) → rate > 0 → the long (alice) PAYS funding, so her equity drops.
        int256 aliceEqAfter = engine.equityOf(BTC, alice, MARK0);
        assertLt(aliceEqAfter, aliceEqBefore);
    }

    function test_settlerOwnsEngine() public view {
        // The settler must own the engine for checkpoint() to be authorized.
        assertEq(engine.owner(), address(settler));
    }

    function test_returnEngineOwnership() public {
        settler.returnEngineOwnership(owner);
        assertEq(engine.owner(), owner);
    }

    function test_supportsInterface() public view {
        assertTrue(settler.supportsInterface(type(IReceiver).interfaceId));
    }
}
