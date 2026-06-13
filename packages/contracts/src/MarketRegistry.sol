// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MarketParams} from "./Types.sol";

/// @title MarketRegistry — the registry of SideKick markets (Doc 2 §2.1).
/// @notice Holds, per market, its economic parameters `{m, α, λ, r_max, k}` (from the Phase-1
///         sweep), its Pool contract, and its oracle configuration (which adapter — Stork or
///         Chainlink — and the feed id for that source). Pure data + admin; the per-block loop
///         reads it but never mutates it. Markets are keyed by a `bytes32` id, conventionally the
///         symbol bytes (e.g. `bytes32("BTC-PERP")`).
/// @dev `oracleAdapter` is an {IOracleAdapter}. The Stork feed id is `keccak256(utf8(symbol))`,
///      e.g. `keccak256("BTCUSD")` — verified against the Stork registry in Spike B. In Phase 2 the
///      mark is injected by the engine/test harness, so the adapter is recorded for Phase 3/6 but
///      not yet read by PerpEngine.
contract MarketRegistry is Ownable {
    /// @notice Full configuration for one market.
    struct Market {
        bool exists;
        MarketParams params;
        address pool; // the Pool contract for this isolated market
        address oracleAdapter; // IOracleAdapter (Stork now; Chainlink behind the same interface)
        bytes32 feedId; // source feed id (Stork: keccak256(symbol); Chainlink: its feed id)
        string symbol; // human label, e.g. "BTC-PERP"
    }

    /// @notice marketId → configuration.
    mapping(bytes32 => Market) private _markets;
    /// @notice All registered market ids, for enumeration.
    bytes32[] private _marketIds;

    event MarketRegistered(bytes32 indexed marketId, string symbol, address pool, address oracleAdapter);
    event MarketParamsUpdated(bytes32 indexed marketId, MarketParams params);
    event OracleUpdated(bytes32 indexed marketId, address oracleAdapter, bytes32 feedId);

    error MarketAlreadyExists();
    error MarketNotFound();
    error ZeroAddress();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Register a new market. Owner-only.
    /// @param marketId      Stable id (e.g. `bytes32("BTC-PERP")`).
    /// @param symbol        Human label.
    /// @param params        Economic parameters (Phase-1 sweep values).
    /// @param pool          The market's Pool contract.
    /// @param oracleAdapter The IOracleAdapter to read the mark from.
    /// @param feedId        The source's feed id for this asset.
    function registerMarket(
        bytes32 marketId,
        string calldata symbol,
        MarketParams calldata params,
        address pool,
        address oracleAdapter,
        bytes32 feedId
    ) external onlyOwner {
        if (_markets[marketId].exists) revert MarketAlreadyExists();
        if (pool == address(0) || oracleAdapter == address(0)) revert ZeroAddress();
        _markets[marketId] = Market({
            exists: true,
            params: params,
            pool: pool,
            oracleAdapter: oracleAdapter,
            feedId: feedId,
            symbol: symbol
        });
        _marketIds.push(marketId);
        emit MarketRegistered(marketId, symbol, pool, oracleAdapter);
    }

    /// @notice Update a market's economic parameters (e.g. after a fresh sweep). Owner-only.
    function setParams(bytes32 marketId, MarketParams calldata params) external onlyOwner {
        if (!_markets[marketId].exists) revert MarketNotFound();
        _markets[marketId].params = params;
        emit MarketParamsUpdated(marketId, params);
    }

    /// @notice Repoint a market's oracle (e.g. swap Stork → Chainlink for Connect-the-World). Owner-only.
    function setOracle(bytes32 marketId, address oracleAdapter, bytes32 feedId) external onlyOwner {
        if (!_markets[marketId].exists) revert MarketNotFound();
        if (oracleAdapter == address(0)) revert ZeroAddress();
        _markets[marketId].oracleAdapter = oracleAdapter;
        _markets[marketId].feedId = feedId;
        emit OracleUpdated(marketId, oracleAdapter, feedId);
    }

    // ── Views ───────────────────────────────────────────────────────────────────

    /// @notice Full market config; reverts if unknown.
    function getMarket(bytes32 marketId) external view returns (Market memory) {
        Market memory m = _markets[marketId];
        if (!m.exists) revert MarketNotFound();
        return m;
    }

    /// @notice Just the economic parameters; reverts if unknown. Hot path for the engine.
    function getParams(bytes32 marketId) external view returns (MarketParams memory) {
        Market storage m = _markets[marketId];
        if (!m.exists) revert MarketNotFound();
        return m.params;
    }

    /// @notice The Pool contract for a market; reverts if unknown.
    function poolOf(bytes32 marketId) external view returns (address) {
        Market storage m = _markets[marketId];
        if (!m.exists) revert MarketNotFound();
        return m.pool;
    }

    /// @notice Whether a market is registered.
    function exists(bytes32 marketId) external view returns (bool) {
        return _markets[marketId].exists;
    }

    /// @notice Number of registered markets.
    function marketCount() external view returns (uint256) {
        return _marketIds.length;
    }

    /// @notice Market id at `index` (0-based, registration order).
    function marketIdAt(uint256 index) external view returns (bytes32) {
        return _marketIds[index];
    }
}
