// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChainlinkAdapter} from "../src/oracle/ChainlinkAdapter.sol";
import {IOracleAdapter} from "../src/oracle/IOracleAdapter.sol";
import {IVerifierProxy, ReportV3} from "../src/oracle/IChainlinkStreams.sol";

/// @notice A stand-in Data Streams Verifier: echoes back an ABI-encoded {ReportV3} for whatever
///         report id the test sets, mimicking the real proxy's "verify → return decoded body" shape
///         without a DON signature. Lets us exercise pushReport/getMark end-to-end on-chain.
contract MockVerifier is IVerifierProxy {
    ReportV3 public next;

    function setNext(ReportV3 calldata r) external {
        next = r;
    }

    function verify(bytes calldata, bytes calldata) external payable returns (bytes memory) {
        return abi.encode(next);
    }

    function s_feeManager() external pure returns (address) {
        return address(0);
    }
}

/// @notice ChainlinkAdapter: the store-and-expose semantics, normalization, staleness gate, and the
///         real-adapter registry swap (the existing Registry test only swaps to a mock address).
contract ChainlinkAdapterTest is Test {
    bytes32 constant FEED = bytes32(uint256(0x0003abc));
    address constant FEE_TOKEN = address(0xFEE);

    MockVerifier verifier;
    ChainlinkAdapter adapter;

    function setUp() public {
        vm.warp(1_000_000); // a non-zero wall clock so staleness math is meaningful
        verifier = new MockVerifier();
        adapter = new ChainlinkAdapter(address(verifier), FEED, FEE_TOKEN, address(this));
    }

    function _report(int192 price, uint32 obsTs) internal pure returns (ReportV3 memory r) {
        r.feedId = FEED;
        r.observationsTimestamp = obsTs;
        r.expiresAt = obsTs + 3600;
        r.price = price;
    }

    function test_source_isChainlink() public view {
        assertEq(adapter.source(), "chainlink");
    }

    function test_getMark_revertsBeforeAnyPush() public {
        vm.expectRevert(ChainlinkAdapter.StaleMark.selector);
        adapter.getMark();
    }

    function test_pushReport_storesNormalizedMark() public {
        // price is already int192 @ 18dp → no rescale; observationsTimestamp(sec)×1000 → ms.
        verifier.setNext(_report(64_000e18, uint32(block.timestamp)));
        adapter.pushReport(hex"00");

        IOracleAdapter.Mark memory m = adapter.getMark();
        assertEq(m.price18, 64_000e18, "price passes through at 18dp");
        assertEq(m.timestampMs, uint64(block.timestamp) * 1000, "seconds -> ms");
    }

    function test_pushReport_rejectsWrongFeed() public {
        ReportV3 memory r = _report(1e18, uint32(block.timestamp));
        r.feedId = bytes32(uint256(0xdead));
        verifier.setNext(r);
        vm.expectRevert(ChainlinkAdapter.FeedMismatch.selector);
        adapter.pushReport(hex"00");
    }

    function test_getMark_revertsWhenStale() public {
        verifier.setNext(_report(50_000e18, uint32(block.timestamp)));
        adapter.pushReport(hex"00");
        adapter.getMark(); // fresh now

        vm.warp(block.timestamp + 3601); // past the 3600s default window
        vm.expectRevert(ChainlinkAdapter.StaleMark.selector);
        adapter.getMark();
    }

    /// Regression: a mark whose observation timestamp LEADS the block clock (Data Streams' clock can
    /// run ahead of an L2/L3 finalized block) must read as FRESH, not underflow-revert. Before the
    /// guard, `block.timestamp*1000 - timestampMs` panicked (0x11) on a future-dated mark.
    function test_getMark_futureObservationIsFresh() public {
        uint64 futureMs = uint64(block.timestamp) * 1000 + 2000; // observed 2s ahead
        adapter.pushMarkUnverified(8e18, futureMs);
        IOracleAdapter.Mark memory m = adapter.getMark(); // must NOT revert
        assertEq(m.price18, 8e18);
        assertEq(m.timestampMs, futureMs);
    }

    function test_onlyWriter_canPush() public {
        verifier.setNext(_report(1e18, uint32(block.timestamp)));
        vm.prank(address(0xBEEF));
        vm.expectRevert(ChainlinkAdapter.NotWriter.selector);
        adapter.pushReport(hex"00");
    }

    function test_pushMarkUnverified_relayModeWhenNoVerifier() public {
        // Arc-not-yet-live mode: verifier address(0); owner seeds a chainlink-sourced mark.
        ChainlinkAdapter relay = new ChainlinkAdapter(address(0), FEED, FEE_TOKEN, address(this));
        vm.expectRevert(ChainlinkAdapter.VerifierUnavailable.selector);
        relay.pushReport(hex"00");

        relay.pushMarkUnverified(42_000e18, uint64(block.timestamp) * 1000);
        IOracleAdapter.Mark memory m = relay.getMark();
        assertEq(m.price18, 42_000e18);
        assertEq(relay.source(), "chainlink", "provenance stays honest even in relay mode");
    }
}
