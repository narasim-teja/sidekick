// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarkReceiver} from "../src/oracle/MarkReceiver.sol";
import {IOracleAdapter} from "../src/oracle/IOracleAdapter.sol";
import {IReceiver} from "../src/oracle/keystone/IReceiver.sol";

/// @title MarkReceiverTest — proves the CRE consumer surface that satisfies the Chainlink bounty:
///        only the KeystoneForwarder can write the mark via onReport, the engine reads it via
///        getMark, and the read enforces freshness (so the resilient oracle falls back if the DON
///        stops). This is the on-chain state change a Chainlink service makes inside the contract.
contract MarkReceiverTest is Test {
    MarkReceiver receiver;
    address forwarder = address(0xF0);
    address simForwarder = address(0xF1);
    address owner = address(this);
    bytes32 constant FEED = bytes32(uint256(0x1234));

    function setUp() public {
        address[] memory fwds = new address[](2);
        fwds[0] = forwarder;
        fwds[1] = simForwarder;
        receiver = new MarkReceiver(fwds, FEED, owner);
    }

    /// Encode a MarkReport exactly as the CRE workflow does.
    function _report(int256 price18, uint64 tsMs) internal pure returns (bytes memory) {
        return abi.encode(MarkReceiver.MarkReport({price18: price18, timestampMs: tsMs}));
    }

    function test_onlyForwarderCanWrite() public {
        vm.expectRevert(abi.encodeWithSelector(MarkReceiver.UnauthorizedForwarder.selector, address(this)));
        receiver.onReport("", _report(8e18, uint64(block.timestamp) * 1000));
    }

    function test_forwarderWritesMark_andEngineReads() public {
        uint64 tsMs = uint64(block.timestamp) * 1000;
        vm.prank(forwarder);
        receiver.onReport("meta", _report(8_002161219299909000, tsMs));

        assertEq(receiver.reportCount(), 1);
        IOracleAdapter.Mark memory m = receiver.getMark();
        assertEq(m.price18, 8_002161219299909000);
        assertEq(m.timestampMs, tsMs);
        assertEq(receiver.source(), "chainlink");
    }

    /// Both the production forwarder AND the allowlisted simulator forwarder can write — this is what
    /// lets `cre workflow simulate --broadcast` land a real mark while production stays gated to Arc's.
    function test_bothForwardersAccepted() public {
        uint64 tsMs = uint64(block.timestamp) * 1000;
        vm.prank(simForwarder);
        receiver.onReport("", _report(7_974e15, tsMs));
        assertEq(receiver.getMark().price18, 7_974e15);

        vm.prank(forwarder);
        receiver.onReport("", _report(8_000e15, tsMs));
        assertEq(receiver.getMark().price18, 8_000e15);
        assertEq(receiver.reportCount(), 2);
    }

    function test_getMark_revertsWhenNeverReported() public {
        vm.expectRevert(MarkReceiver.StaleMark.selector);
        receiver.getMark();
    }

    function test_getMark_revertsWhenStale() public {
        // Report at "now", then jump past the staleness window.
        uint64 tsMs = uint64(block.timestamp) * 1000;
        vm.prank(forwarder);
        receiver.onReport("", _report(8e18, tsMs));
        vm.warp(block.timestamp + 3601); // maxStaleness = 3600s
        vm.expectRevert(MarkReceiver.StaleMark.selector);
        receiver.getMark();
    }

    function test_supportsInterface() public view {
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IOracleAdapter).interfaceId));
    }

    function test_setForwarder_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        receiver.setForwarder(address(0xABCD), true);

        receiver.setForwarder(address(0xABCD), true);
        assertTrue(receiver.authorizedForwarder(address(0xABCD)));

        // A newly-allowed forwarder can write; a revoked one cannot.
        uint64 tsMs = uint64(block.timestamp) * 1000;
        vm.prank(address(0xABCD));
        receiver.onReport("", _report(5e18, tsMs));
        assertEq(receiver.getMark().price18, 5e18);

        receiver.setForwarder(address(0xABCD), false);
        vm.prank(address(0xABCD));
        vm.expectRevert(abi.encodeWithSelector(MarkReceiver.UnauthorizedForwarder.selector, address(0xABCD)));
        receiver.onReport("", _report(6e18, tsMs));
    }
}
