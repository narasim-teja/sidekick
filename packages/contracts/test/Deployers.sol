// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SideKickUSDC} from "../src/test/SideKickUSDC.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {Vault} from "../src/Vault.sol";
import {Pool} from "../src/Pool.sol";
import {LPToken} from "../src/LPToken.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {AccountManager} from "../src/AccountManager.sol";
import {MarketParams, Side} from "../src/Types.sol";
import {Params} from "../src/generated/Params.sol";

/// @title Deployers — a wired SideKick venue for tests, mirroring the production deploy graph.
/// @notice Brings up: USDC → Vault → MarketRegistry → PerpEngine → (per market) Pool + LPToken,
///         then wires operators/engine and registers one market with the Phase-1 sweep params.
///         A throwaway oracle adapter address is recorded in the registry (mark is injected in
///         Phase 2, so the adapter is not read by the engine here).
abstract contract Deployers is Test {
    // Phase-1 sweep-selected params, from the GENERATED {Params} library (same source the deploy
    // uses): m = 0.01, alpha = 0.0005, lambda = 0.08, rMax = 0.0005, k = 3. Re-exposed as locals so
    // the existing tests read them by name; the values come from `Params`, not hand-typed literals.
    int256 internal constant M = Params.M;
    int256 internal constant ALPHA = Params.ALPHA;
    int256 internal constant LAMBDA = Params.LAMBDA;
    int256 internal constant R_MAX = Params.R_MAX;
    uint256 internal constant K = Params.K;

    uint256 internal constant BLOCK_SECONDS = 2;
    uint256 internal constant FUNDING_PERIOD_SECONDS = 8 hours;

    // WAD scale and a convenient mark (1 unit = $70,000, 18dp) and USDC unit (6dp).
    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDC = 1e6;
    uint256 internal constant MARK0 = 70_000e18; // $70k in WAD (price18)

    bytes32 internal constant BTC = bytes32("BTC-PERP");
    address internal constant ORACLE_STUB = address(0xBEEF);

    SideKickUSDC internal usdc;
    Vault internal vault;
    MarketRegistry internal registry;
    PerpEngine internal engine;
    AccountManager internal accounts;
    Pool internal pool;
    LPToken internal lp;

    address internal owner = address(this); // the test contract owns + drives checkpoints

    /// @dev Stand up and fully wire the venue with one registered BTC market.
    function _deployVenue() internal {
        usdc = new SideKickUSDC();
        vault = new Vault(address(usdc), owner);
        registry = new MarketRegistry(owner);
        engine = new PerpEngine(address(registry), address(vault), BLOCK_SECONDS, FUNDING_PERIOD_SECONDS, owner);
        accounts = new AccountManager(address(vault), address(engine));

        // Per-market Pool + its slpUSDC LP token (pool referenced by the token, set back into pool).
        pool = new Pool(BTC, address(vault), owner);
        lp = new LPToken("SideKick BTC-PERP LP", "slpUSDC-BTC", address(pool));
        pool.setLpToken(address(lp));
        pool.setEngine(address(engine));

        // Operators: the engine (loop) and the pool (LP deposit/withdraw, gap seed) move claims.
        vault.setOperator(address(engine), true);
        vault.setOperator(address(pool), true);

        // Register the market with the swept params.
        registry.registerMarket(BTC, "BTC-PERP", Params.defaults(), address(pool), ORACLE_STUB, keccak256("BTCUSD"));
    }

    // ── Funding / liquidity helpers ────────────────────────────────────────────────

    /// @dev Mint USDC to `who` and deposit it into the vault as free collateral.
    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    /// @dev Seed the pool with `capital` of LP liquidity and `gap` into the gap fund, from `lpAddr`.
    function _seedPool(address lpAddr, uint256 capital, uint256 gap) internal {
        _fund(lpAddr, capital + gap);
        vm.startPrank(lpAddr);
        pool.provideLiquidity(capital);
        if (gap > 0) pool.seedGapFund(gap);
        vm.stopPrank();
    }

    /// @dev Open a position for `who`.
    function _open(address who, Side side, uint256 notional, uint256 margin, uint256 mark) internal {
        vm.prank(who);
        engine.openPosition(BTC, side, notional, margin, mark);
    }

    /// @dev Total USDC claims that must equal the vault's token balance (conservation ledger):
    ///      Σ free collateral (tracked per account by the caller) + Σ position margin + pool
    ///      capital + gap fund. The caller passes the account list so free collateral + margin sum.
    function _totalClaims(address[] memory accts) internal view returns (uint256 total) {
        total = pool.capital() + pool.gapFund();
        for (uint256 i = 0; i < accts.length; i++) {
            total += vault.freeCollateral(accts[i]);
            total += engine.positionOf(BTC, accts[i]).margin;
        }
    }
}
