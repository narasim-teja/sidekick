// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStork} from "@storknetwork/stork-evm-sdk/IStork.sol";
import {StorkStructs} from "@storknetwork/stork-evm-sdk/StorkStructs.sol";
import {IOracleAdapter} from "./IOracleAdapter.sol";

/// @title StorkAdapter — Stork implementation of the pluggable oracle adapter.
/// @notice Reads a single Stork feed and normalizes it to the common {IOracleAdapter.Mark}.
///         Uses the *Unsafe* getter (no staleness revert) so the spike can read even a feed
///         that has not been freshly pushed; the venue will switch to the freshness-checked
///         getter (or push an update first) in production.
/// @dev Stork quantizes USD price feeds to 18 decimals, so `quantizedValue` maps directly to
///      `price18`. Timestamp is nanoseconds → milliseconds.
contract StorkAdapter is IOracleAdapter {
    /// @notice The Stork oracle contract on Arc.
    IStork public immutable stork;
    /// @notice The encoded asset id (feed id) this adapter reads, e.g. for BTCUSD.
    bytes32 public immutable assetId;

    constructor(address storkContract, bytes32 assetId_) {
        stork = IStork(storkContract);
        assetId = assetId_;
    }

    /// @inheritdoc IOracleAdapter
    function getMark() external view returns (Mark memory mark) {
        StorkStructs.TemporalNumericValue memory v = stork.getTemporalNumericValueUnsafeV1(assetId);
        // quantizedValue is int192 at 18 decimals → widen to int256; ns → ms.
        mark = Mark({price18: int256(v.quantizedValue), timestampMs: v.timestampNs / 1_000_000});
    }

    /// @inheritdoc IOracleAdapter
    function source() external pure returns (string memory) {
        return "stork";
    }
}
