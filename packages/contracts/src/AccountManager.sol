// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Position, Side} from "./Types.sol";
import {Vault} from "./Vault.sol";

/// @notice Minimal read surface PerpEngine exposes for the unified-account view.
interface IPerpEnginePositions {
    function positionOf(bytes32 marketId, address account) external view returns (Position memory);
    function equityOf(bytes32 marketId, address account, uint256 mark) external view returns (int256);
}

/// @title AccountManager — the unified-account primitive (Doc 1 §3.2).
/// @notice There is ONE account type: `collateral + position(s) + (later) strategy`. Trader, LP,
///         MM-agent, oracle-agent are all the same object, distinguished only by what they hold.
///         This contract is the read-side aggregator over that object: it joins an account's
///         free collateral (in the {Vault}) with its position (in {PerpEngine}) into one view, and
///         optionally links an **ERC-8004 identity** to the account (Doc 1 §8 — present-but-optional
///         in the POC). It deliberately holds no money and runs no risk logic — the settlement loop
///         never branches on "is this an LP", so there is nothing account-type-specific to enforce
///         here; it is the unified *lens*, not a gatekeeper.
/// @dev Identity linking is self-sovereign: an account links its own ERC-8004 token id. The id is
///      stored for reputation/discovery surfaces; no on-chain verification of the registry is done
///      in the POC (the ERC-8004 registry integration lands with the SDK onboarding, Phase 5).
contract AccountManager {
    /// @notice The collateral vault.
    Vault public immutable vault;
    /// @notice The settlement engine holding positions.
    IPerpEnginePositions public immutable engine;

    /// @notice account → linked ERC-8004 identity token id (0 = unlinked).
    mapping(address => uint256) public identityOf;

    /// @notice A consolidated snapshot of a unified account in one market.
    struct AccountView {
        uint256 freeCollateral; // USDC 6dp, un-utilized
        Position position; // the single open position (Flat if none)
        int256 positionEquity; // margin + unrealized pricePnl at `mark`, USDC 6dp
        uint256 identity; // linked ERC-8004 id (0 if none)
    }

    event IdentityLinked(address indexed account, uint256 indexed identityId);

    constructor(address vault_, address engine_) {
        vault = Vault(vault_);
        engine = IPerpEnginePositions(engine_);
    }

    /// @notice Link an ERC-8004 identity token id to the caller's account (self-sovereign).
    function linkIdentity(uint256 identityId) external {
        identityOf[msg.sender] = identityId;
        emit IdentityLinked(msg.sender, identityId);
    }

    /// @notice The consolidated unified-account view for `account` in `marketId` at `mark`.
    function accountView(bytes32 marketId, address account, uint256 mark) external view returns (AccountView memory) {
        return AccountView({
            freeCollateral: vault.freeCollateral(account),
            position: engine.positionOf(marketId, account),
            positionEquity: engine.equityOf(marketId, account, mark),
            identity: identityOf[account]
        });
    }
}
