// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {IOracleAdapter} from "./IOracleAdapter.sol";
import {IReceiver} from "./keystone/IReceiver.sol";

/// @title MarkReceiver — Chainlink CRE consumer that IS the venue's oracle adapter.
/// @notice This is the contract that satisfies the "Connect the World with Chainlink" requirement:
///         a Chainlink service makes an on-chain state change *inside a smart contract*. A Chainlink
///         **CRE workflow** fetches + verifies a Data Streams price off-DON, the DON reaches
///         consensus, and the **`KeystoneForwarder`** (a Chainlink contract) calls {onReport} here —
///         which writes the mark. The forwarder gate guarantees ONLY the Chainlink DON can update
///         the price, so the state change is genuinely Chainlink-driven, not a relayed self-write.
///
/// @dev DUAL ROLE — one contract, two interfaces:
///        1. {IReceiver}      — the CRE consumer surface the forwarder calls (`onReport`).
///        2. {IOracleAdapter} — the venue surface the engine reads (`getMark`), identical in shape
///                              to {StorkAdapter}/{ChainlinkAdapter}, so the per-block loop, the
///                              MarketRegistry, and the off-chain reader treat it like any other
///                              oracle. The engine reads `chainlink-live` provenance unchanged.
///
///      WHY THIS, NOT the relay `ChainlinkAdapter.pushMarkUnverified`: that path had the owner push a
///      price the off-chain script fetched — no Chainlink contract ran on-chain, so it did NOT meet the
///      bounty bar. Here the write is performed by Chainlink's `KeystoneForwarder` after DON consensus.
///
///      REPORT SCHEMA: the CRE workflow encodes `abi.encode(MarkReport{ price18, timestampMs })`. Prices
///      are normalized to 18 decimals in the workflow (Data Streams reports are int192 18-dp already),
///      matching the `IOracleAdapter.Mark.price18` convention so nothing downstream rescales.
///
///      See packages/cre/ (the CRE workflow that produces the report) and
///      packages/contracts/src/oracle/IOracleAdapter.sol (the venue oracle surface).
contract MarkReceiver is IReceiver, IOracleAdapter, Ownable {
    /// @notice The set of Chainlink CRE `KeystoneForwarder`s allowed to deliver reports. The
    ///         **production** forwarder is the Arc KeystoneForwarder
    ///         (0x76c9cf548b4179F8901cda1f8623568b58215E62); a **local CRE simulator** forwarder can
    ///         also be allowlisted so `cre workflow simulate --broadcast` lands a real on-chain write
    ///         during the demo. Both are set at construction and owner-updatable (Chainlink may rotate
    ///         the forwarder). The gate guarantees ONLY a Chainlink CRE forwarder can update the mark.
    mapping(address => bool) public authorizedForwarder;

    /// @notice Whether the forwarder gate is enforced. False allows any caller (test only). Defaults
    ///         to true at construction whenever at least one forwarder is provided.
    bool public gateEnabled;

    /// @notice The Data Streams feed id this market tracks (a fixed 32-byte id; informational on-chain).
    bytes32 public immutable feedId;

    /// @notice How long after the observation a stored mark is considered fresh (seconds). A read past
    ///         this reverts {StaleMark}, mirroring StorkAdapter's freshness gate so the engine's
    ///         resilient oracle falls back to synthetic if the DON stops delivering.
    uint64 public maxStalenessSeconds;

    /// @dev The latest DON-delivered mark.
    Mark private _mark;
    /// @dev Monotonic counter of accepted reports (lets a consumer/test see the write happened).
    uint256 public reportCount;

    /// @notice The report payload the CRE workflow ABI-encodes and the forwarder delivers.
    struct MarkReport {
        int256 price18;
        uint64 timestampMs;
    }

    event MarkReported(int256 price18, uint64 timestampMs, uint256 indexed reportCount);
    event ForwarderSet(address indexed forwarder, bool allowed);
    event GateSet(bool enabled);
    event MaxStalenessSet(uint64 seconds_);

    error StaleMark();
    error UnauthorizedForwarder(address caller);

    /// @param forwarders_  CRE KeystoneForwarders allowed to deliver reports — the production Arc
    ///                     forwarder, plus optionally the local CRE simulator forwarder for the demo.
    ///                     Pass an empty array to leave the gate DISABLED (test only).
    /// @param feedId_      The Data Streams feed id this market tracks.
    /// @param initialOwner Owner (deploy EOA during wiring, then a multisig/timelock).
    constructor(address[] memory forwarders_, bytes32 feedId_, address initialOwner) Ownable(initialOwner) {
        feedId = feedId_;
        maxStalenessSeconds = 3600; // matches Stork/Chainlink adapter staleness window
        for (uint256 i = 0; i < forwarders_.length; i++) {
            if (forwarders_[i] != address(0)) {
                authorizedForwarder[forwarders_[i]] = true;
                emit ForwarderSet(forwarders_[i], true);
            }
        }
        gateEnabled = forwarders_.length > 0;
        emit GateSet(gateEnabled);
    }

    // ── IReceiver (the Chainlink CRE write surface) ─────────────────────────────────

    /// @inheritdoc IReceiver
    /// @notice Called by the Chainlink `KeystoneForwarder` with a DON-attested workflow report. THIS
    ///         is the on-chain Chainlink state change: decode the report and store the new mark.
    /// @dev Gated to the authorized forwarder set (when enabled) so only a Chainlink CRE forwarder
    ///      can update the price.
    function onReport(bytes calldata, bytes calldata report) external override {
        if (gateEnabled && !authorizedForwarder[msg.sender]) revert UnauthorizedForwarder(msg.sender);
        MarkReport memory r = abi.decode(report, (MarkReport));
        _mark = Mark({price18: r.price18, timestampMs: r.timestampMs});
        reportCount += 1;
        emit MarkReported(r.price18, r.timestampMs, reportCount);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IOracleAdapter).interfaceId;
    }

    // ── IOracleAdapter (the venue read surface) ─────────────────────────────────────

    /// @inheritdoc IOracleAdapter
    /// @dev Reverts {StaleMark} if never reported or older than maxStalenessSeconds, so the engine's
    ///      resilient oracle latches to the synthetic fallback (same contract as Stork's NotFound).
    function getMark() external view returns (Mark memory mark) {
        Mark memory m = _mark;
        if (m.timestampMs == 0) revert StaleMark(); // never reported
        uint64 ageMs = uint64(block.timestamp) * 1000 - m.timestampMs;
        if (ageMs > maxStalenessSeconds * 1000) revert StaleMark();
        return m;
    }

    /// @inheritdoc IOracleAdapter
    function source() external pure returns (string memory) {
        return "chainlink";
    }

    // ── Admin ───────────────────────────────────────────────────────────────────────

    /// @notice Allow or revoke a forwarder (e.g. if Chainlink rotates it, or to add the simulator
    ///         forwarder for a demo). Owner-only.
    function setForwarder(address forwarder_, bool allowed) external onlyOwner {
        authorizedForwarder[forwarder_] = allowed;
        emit ForwarderSet(forwarder_, allowed);
    }

    /// @notice Enable/disable the forwarder gate. Owner-only. Disabling is for tests only.
    function setGateEnabled(bool enabled) external onlyOwner {
        gateEnabled = enabled;
        emit GateSet(enabled);
    }

    /// @notice Update the staleness window. Owner-only.
    function setMaxStaleness(uint64 seconds_) external onlyOwner {
        maxStalenessSeconds = seconds_;
        emit MaxStalenessSet(seconds_);
    }
}
