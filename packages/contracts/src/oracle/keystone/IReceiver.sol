// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";

/// @title IReceiver — receives Chainlink CRE (keystone) reports.
/// @notice The interface the Chainlink CRE `KeystoneForwarder` calls to deliver a DON-attested
///         workflow report on-chain. A consumer implements `onReport`; the forwarder validates the
///         DON signatures off-path and then calls this — so a successful `onReport` IS a Chainlink
///         service making an on-chain state change. Vendored verbatim from the CRE templates
///         (`keystone/interfaces/IReceiver.sol`) so we don't pull the full keystone package.
/// @dev Implementations must advertise support via ERC-165 (`supportsInterface`).
interface IReceiver is IERC165 {
    /// @notice Handle an incoming keystone report.
    /// @dev If this reverts it can be retried with a higher gas limit; the receiver is responsible
    ///      for discarding stale reports.
    /// @param metadata Report metadata (workflow id, DON id, execution id — opaque here).
    /// @param report The ABI-encoded workflow report payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
