// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deployers} from "./Deployers.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {AccountManager} from "../src/AccountManager.sol";
import {MarketParams, Position, Side} from "../src/Types.sol";

/// @notice MarketRegistry config/admin tests + the unified-account view (AccountManager).
contract RegistryTest is Deployers {
    address trader;

    function setUp() public {
        trader = makeAddr("trader");
        _deployVenue();
        _seedPool(makeAddr("lp"), 1_000_000 * USDC, 0);
    }

    function test_registeredMarket_hasSweptParams() public view {
        MarketRegistry.Market memory m = registry.getMarket(BTC);
        assertEq(m.params.m, M);
        assertEq(m.params.alpha, ALPHA);
        assertEq(m.params.lambda, LAMBDA);
        assertEq(m.params.rMax, R_MAX);
        assertEq(m.params.k, K);
        assertEq(m.pool, address(pool));
        assertEq(m.feedId, keccak256("BTCUSD"), "Stork feed id = keccak256(symbol)");
    }

    function test_registerDuplicate_reverts() public {
        vm.expectRevert(MarketRegistry.MarketAlreadyExists.selector);
        registry.registerMarket(
            BTC,
            "BTC-PERP",
            MarketParams({m: M, alpha: ALPHA, lambda: LAMBDA, rMax: R_MAX, k: K}),
            address(pool),
            ORACLE_STUB,
            keccak256("BTCUSD")
        );
    }

    function test_getMarket_unknown_reverts() public {
        vm.expectRevert(MarketRegistry.MarketNotFound.selector);
        registry.getMarket(bytes32("NOPE"));
    }

    function test_setParams_onlyOwner() public {
        vm.prank(trader);
        vm.expectRevert();
        registry.setParams(BTC, MarketParams({m: M, alpha: ALPHA, lambda: LAMBDA, rMax: R_MAX, k: K}));
    }

    function test_setOracle_repointsForChainlink() public {
        // Connect-the-World: swap Stork → a Chainlink adapter on this market.
        address chainlink = makeAddr("chainlinkAdapter");
        registry.setOracle(BTC, chainlink, bytes32("CL-LINK"));
        MarketRegistry.Market memory m = registry.getMarket(BTC);
        assertEq(m.oracleAdapter, chainlink);
        assertEq(m.feedId, bytes32("CL-LINK"));
    }

    function test_enumeration() public view {
        assertEq(registry.marketCount(), 1);
        assertEq(registry.marketIdAt(0), BTC);
        assertTrue(registry.exists(BTC));
    }

    // ── unified account view ────────────────────────────────────────────────────────

    function test_accountView_joinsCollateralAndPosition() public {
        _fund(trader, 50_000 * USDC);
        _open(trader, Side.Long, 100_000 * USDC, 20_000 * USDC, MARK0);

        AccountManager.AccountView memory v = accounts.accountView(BTC, trader, MARK0);
        assertEq(v.freeCollateral, 30_000 * USDC);
        assertEq(uint256(v.position.side), uint256(Side.Long));
        assertEq(v.position.entryNotional, 100_000 * USDC);
        assertEq(v.positionEquity, int256(uint256(20_000 * USDC)), "equity = margin at entry mark");
        assertEq(v.identity, 0, "no identity linked yet");
    }

    function test_linkIdentity_erc8004() public {
        vm.prank(trader);
        accounts.linkIdentity(42);
        assertEq(accounts.identityOf(trader), 42);
        AccountManager.AccountView memory v = accounts.accountView(BTC, trader, MARK0);
        assertEq(v.identity, 42);
    }
}
