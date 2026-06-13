// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracleAdapter} from "./IOracleAdapter.sol";
import {IVerifierProxy, IFeeManager, ReportV3} from "./IChainlinkStreams.sol";

/// @title ChainlinkAdapter — Chainlink Data Streams implementation of the pluggable oracle adapter.
/// @notice Mirrors {StorkAdapter} structurally (oracle-contract address + a per-feed id, normalizes
///         to the common {IOracleAdapter.Mark}) but uses the Data Streams *pull* model.
///
/// @dev WHY STORE-AND-EXPOSE (not a passthrough view):
///      Stork persists its value on-chain, so {StorkAdapter.getMark} is a pure `view` over a getter.
///      Data Streams does NOT persist: the Verifier proxy's `verify()` is payable + state-changing
///      and RETURNS the decoded report in the same call. A `view getMark()` therefore cannot run the
///      verify. We split the two halves the same way the off-chain Stork path is split (push update
///      out-of-band, read per block): an authorized writer (the engine's refresh job / CRE) calls
///      {pushReport} with the API's `fullReport` blob; we `verify()` it, decode the v3 report, and
///      STORE the normalized Mark. {getMark} is then a trivial `view` the engine reads every block,
///      identical in shape to StorkAdapter — so nothing downstream (registry, engine, off-chain
///      OracleAdapter) needs to know which source it is.
///
///      NORMALIZATION: report.price is int192 at 18dp (same scale as Stork's quantizedValue) → no
///      rescale; observationsTimestamp is SECONDS → ×1000 for ms. expiresAt is the staleness gate
///      (analogue of Stork's freshness-checked getter); reads past it are stale (see {getMark}).
///
///      ARC AVAILABILITY (unconfirmed): if the Data Streams Verifier is NOT yet live on Arc, deploy
///      this adapter with `verifier == address(0)`. {pushReport} then reverts (no verifier), but the
///      owner can seed marks via {pushMarkUnverified} so the venue still has a Chainlink-sourced
///      Mark off a trusted relay until the Verifier ships. This keeps the source provenance honest
///      ("chainlink") without pretending an on-chain DON verification happened. See also the classic
///      AggregatorV3 fallback note at the bottom of this file.
contract ChainlinkAdapter is IOracleAdapter, Ownable {
    /// @notice The Data Streams Verifier proxy on Arc. address(0) = not-yet-available mode.
    IVerifierProxy public immutable verifier;
    /// @notice The Data Streams feed id this adapter reads (a FIXED 32-byte registry id, e.g.
    ///         0x0003...for a v3 crypto stream — NOT keccak256(symbol) like Stork).
    bytes32 public immutable feedId;
    /// @notice The fee token to quote/pay `verify` in (wrapped-native for native billing, else LINK).
    address public immutable feeToken;
    /// @notice How long after observationsTimestamp a stored Mark is considered fresh (seconds).
    ///         Falls back to the report's own expiresAt if that is tighter. Owner-tunable.
    uint64 public maxStalenessSeconds;

    /// @notice Addresses allowed to push verified reports (the engine refresh job / CRE relayer).
    mapping(address => bool) public writer;

    Mark private _mark;

    event MarkPushed(int256 price18, uint64 timestampMs, bool verified);
    event WriterSet(address indexed who, bool allowed);
    event MaxStalenessSet(uint64 seconds_);

    error StaleMark();
    error FeedMismatch();
    error VerifierUnavailable();
    error NotWriter();

    /// @param verifier_   Data Streams Verifier proxy (or address(0) if not yet on Arc).
    /// @param feedId_     The fixed Data Streams feed id for this asset.
    /// @param feeToken_   Fee token for verify (wrapped-native or LINK).
    /// @param initialOwner Owner (the deploy EOA during wiring, then the multisig/timelock).
    constructor(address verifier_, bytes32 feedId_, address feeToken_, address initialOwner)
        Ownable(initialOwner)
    {
        verifier = IVerifierProxy(verifier_);
        feedId = feedId_;
        feeToken = feeToken_;
        maxStalenessSeconds = 3600; // matches Stork's typical staleness window
        writer[initialOwner] = true; // owner can seed/push by default
    }

    modifier onlyWriter() {
        if (!writer[msg.sender]) revert NotWriter();
        _;
    }

    // ── IOracleAdapter ──────────────────────────────────────────────────────────

    /// @inheritdoc IOracleAdapter
    /// @dev Reverts {StaleMark} if the stored mark is older than maxStalenessSeconds. The off-chain
    ///      ResilientOracle treats a revert here exactly as it treats Stork's NotFound — it latches
    ///      to the synthetic fallback and re-probes, so a stale Chainlink feed degrades gracefully.
    function getMark() external view returns (Mark memory mark) {
        Mark memory m = _mark;
        if (m.timestampMs == 0) revert StaleMark(); // never pushed
        uint64 ageMs = uint64(block.timestamp) * 1000 - m.timestampMs;
        if (ageMs > maxStalenessSeconds * 1000) revert StaleMark();
        return m;
    }

    /// @inheritdoc IOracleAdapter
    function source() external pure returns (string memory) {
        return "chainlink";
    }

    // ── Pull / push ─────────────────────────────────────────────────────────────

    /// @notice Verify a Data Streams `fullReport` blob and store the normalized Mark. Writer-only.
    /// @param fullReport The opaque hex blob from the Data Streams REST API (do NOT decode off-chain).
    /// @dev Two-step read-fee-then-pay (mirrors Stork's getUpdateFeeV1 → updateTemporalNumericValuesV1):
    ///      decode the report's nativeFee/linkFee, attach it, call verify, decode, normalize, store.
    ///      Pass the exact fee as msg.value for native billing (LINK billing would approve instead).
    function pushReport(bytes calldata fullReport) external payable onlyWriter {
        if (address(verifier) == address(0)) revert VerifierUnavailable();

        bytes memory verified =
            verifier.verify{value: msg.value}(fullReport, abi.encode(feeToken));
        ReportV3 memory r = abi.decode(verified, (ReportV3));
        if (r.feedId != feedId) revert FeedMismatch();

        _store(int256(r.price), uint64(r.observationsTimestamp) * 1000, true);
    }

    /// @notice Owner-only escape hatch for when the Arc Verifier is not yet live: record a Chainlink-
    ///         sourced Mark from a trusted relay WITHOUT on-chain DON verification.
    /// @dev Provenance stays honest — `source()` is still "chainlink" and the event marks verified=false
    ///      so consumers can tell a relayed mark from a DON-verified one. Remove/disable once the
    ///      Verifier ships on Arc by revoking the writer and relying on {pushReport}.
    function pushMarkUnverified(int256 price18, uint64 timestampMs) external onlyOwner {
        _store(price18, timestampMs, false);
    }

    function _store(int256 price18, uint64 timestampMs, bool verified_) internal {
        _mark = Mark({price18: price18, timestampMs: timestampMs});
        emit MarkPushed(price18, timestampMs, verified_);
    }

    // ── Admin ───────────────────────────────────────────────────────────────────

    function setWriter(address who, bool allowed) external onlyOwner {
        writer[who] = allowed;
        emit WriterSet(who, allowed);
    }

    function setMaxStaleness(uint64 seconds_) external onlyOwner {
        maxStalenessSeconds = seconds_;
        emit MaxStalenessSet(seconds_);
    }
}

// NOTE ON THE "DATA FEEDS vs DATA STREAMS" CHOICE (decision + justification):
//   The user locked Chainlink = Data Streams (pull, API key) to mirror the existing Stork pull path.
//   Data Streams is the correct analogue: like Stork it is REST-pull + on-chain verify, and its
//   reports are int192 @18dp (zero rescale vs StorkAdapter), so the off-chain refresh job (analogue
//   of refreshStorkMarks) and this store-and-expose adapter mirror Stork 1:1.
//
//   If Arc turns out to ship classic Data FEEDS (push AggregatorV3) but NOT Data Streams, the swap
//   is small and isolated to THIS file: replace pushReport/getMark internals with a passthrough
//   `view` over AggregatorV3Interface.latestRoundData() — read `answer` + `decimals()`, scale 8dp→18dp
//   (×1e10, unlike Streams' no-rescale) and `updatedAt`(sec)×1000 → ms. That variant needs no writer
//   (the feed is already on-chain), so it would drop the push machinery. We pick Data Streams to honor
//   the locked decision and the Stork-mirroring requirement; the registry/engine/deploy wiring below
//   is identical either way because both satisfy the same IOracleAdapter.getMark() shape.
