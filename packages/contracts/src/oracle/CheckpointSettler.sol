// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {IReceiver} from "./keystone/IReceiver.sol";

/// @notice The slice of {PerpEngine} the settler drives. Owner-gated on the engine; the settler holds
///         that ownership, so a Chainlink CRE report routed through this settler IS the authoritative
///         on-chain settlement write.
interface IPerpEngineSettle {
    function checkpoint(bytes32 marketId, uint256 mark, address[] calldata accounts) external;
    function openAccounts(bytes32 marketId) external view returns (address[] memory);
    function transferOwnership(address newOwner) external;
}

/// @title CheckpointSettler — Chainlink CRE driving the venue's Layer-C settlement on-chain.
/// @notice This is the second, higher-value half of the CRE integration (Doc 2 §6.1 step 3): instead
///         of the off-chain operator triggering `PerpEngine.checkpoint`, a Chainlink **CRE workflow**
///         does. The workflow reads the verified mark + the open-account set, the DON reaches
///         consensus, and the Arc **KeystoneForwarder** calls {onReport} here — which calls
///         `engine.checkpoint(marketId, mark, accounts)`. The settler is the engine's OWNER, so that
///         forwarder→onReport→checkpoint path is the authoritative state transition (funding, margin,
///         decrement) posted to Arc by Chainlink. This makes CRE the verifiable settlement
///         orchestrator, not just the oracle delivery — the load-bearing "writes authoritative state
///         to Arc" use the CRE bounty asks for.
///
/// @dev Gated to a set of authorized forwarders (production Arc KeystoneForwarder + the local CRE
///      simulator forwarder, so `cre workflow simulate --broadcast` lands a real checkpoint). The
///      report payload is `abi.encode(SettleReport{ marketId, mark, accounts })`; the workflow MUST
///      pass the account set it read from `engine.openAccounts(marketId)` (the contract re-verifies
///      each position is live and skips flats, so a stale account is harmless).
contract CheckpointSettler is IReceiver, Ownable {
    /// @notice The engine this settler checkpoints. The settler must be its owner for the call to land.
    IPerpEngineSettle public immutable engine;

    /// @notice CRE KeystoneForwarders allowed to deliver settlement reports.
    mapping(address => bool) public authorizedForwarder;
    /// @notice Whether the forwarder gate is enforced (false = any caller; tests only).
    bool public gateEnabled;

    /// @notice Monotonic count of CRE-driven checkpoints landed (so a verifier can see it happened).
    uint256 public settleCount;

    /// @notice The report payload the CRE settlement workflow ABI-encodes and the forwarder delivers.
    struct SettleReport {
        bytes32 marketId;
        uint256 mark;
        address[] accounts;
    }

    event Settled(bytes32 indexed marketId, uint256 mark, uint256 accountCount, uint256 indexed settleCount);
    event ForwarderSet(address indexed forwarder, bool allowed);
    event GateSet(bool enabled);

    error UnauthorizedForwarder(address caller);

    /// @param engine_      The PerpEngine to checkpoint (the settler must later be made its owner).
    /// @param forwarders_  CRE forwarders allowed to call {onReport} (empty → gate disabled, tests only).
    /// @param initialOwner Owner of THIS settler (admin of the forwarder allowlist).
    constructor(address engine_, address[] memory forwarders_, address initialOwner) Ownable(initialOwner) {
        engine = IPerpEngineSettle(engine_);
        for (uint256 i = 0; i < forwarders_.length; i++) {
            if (forwarders_[i] != address(0)) {
                authorizedForwarder[forwarders_[i]] = true;
                emit ForwarderSet(forwarders_[i], true);
            }
        }
        gateEnabled = forwarders_.length > 0;
        emit GateSet(gateEnabled);
    }

    // ── IReceiver (the Chainlink CRE settlement write surface) ───────────────────────

    /// @inheritdoc IReceiver
    /// @notice Called by the Chainlink KeystoneForwarder with a DON-attested settlement report. THIS
    ///         is the on-chain Chainlink state change: run the venue's §4.3 checkpoint.
    function onReport(bytes calldata, bytes calldata report) external override {
        if (gateEnabled && !authorizedForwarder[msg.sender]) revert UnauthorizedForwarder(msg.sender);
        SettleReport memory r = abi.decode(report, (SettleReport));
        engine.checkpoint(r.marketId, r.mark, r.accounts);
        settleCount += 1;
        emit Settled(r.marketId, r.mark, r.accounts.length, settleCount);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ── Admin ───────────────────────────────────────────────────────────────────────

    /// @notice Allow/revoke a forwarder (Chainlink rotation, or adding the simulator forwarder). Owner.
    function setForwarder(address forwarder_, bool allowed) external onlyOwner {
        authorizedForwarder[forwarder_] = allowed;
        emit ForwarderSet(forwarder_, allowed);
    }

    /// @notice Enable/disable the forwarder gate. Owner-only. Disabling is for tests only.
    function setGateEnabled(bool enabled) external onlyOwner {
        gateEnabled = enabled;
        emit GateSet(enabled);
    }

    /// @notice Escape hatch: hand the engine's ownership back to a new owner (e.g. to retire CRE
    ///         settlement or migrate). Owner-only; the settler must currently own the engine.
    function returnEngineOwnership(address newOwner) external onlyOwner {
        engine.transferOwnership(newOwner);
    }
}
