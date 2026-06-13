// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deployers} from "./Deployers.sol";
import {Vault} from "../src/Vault.sol";
import {Side} from "../src/Types.sol";

/// @notice Custody + free-collateral accounting tests for the Vault, including the
///         withdraw-limited-to-free-collateral rule (Doc 1 §3.4) and operator gating.
contract VaultTest is Deployers {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        _deployVenue();
    }

    function test_deposit_increasesFreeCollateral() public {
        _fund(alice, 1_000 * USDC);
        assertEq(vault.freeCollateral(alice), 1_000 * USDC);
        assertEq(usdc.balanceOf(address(vault)), 1_000 * USDC);
    }

    function test_withdraw_returnsUSDC() public {
        _fund(alice, 1_000 * USDC);
        vm.prank(alice);
        vault.withdraw(400 * USDC);
        assertEq(vault.freeCollateral(alice), 600 * USDC);
        assertEq(usdc.balanceOf(alice), 400 * USDC);
    }

    function test_withdraw_overFreeCollateral_reverts() public {
        _fund(alice, 1_000 * USDC);
        vm.prank(alice);
        vm.expectRevert(Vault.InsufficientFreeCollateral.selector);
        vault.withdraw(1_001 * USDC);
    }

    function test_withdraw_cannotTakeCapitalBackingOI() public {
        // Doc 1 §3.4: capital posted as margin / pool capital is utilized and not withdrawable.
        _fund(alice, 1_000 * USDC);
        // Post 800 as margin via an open (needs a seeded pool to absorb).
        _seedPool(bob, 1_000_000 * USDC, 10_000 * USDC);
        _open(alice, Side.Long, 50_000 * USDC, 800 * USDC, MARK0);
        // Only 200 free collateral remains; the 800 backing OI cannot be withdrawn.
        assertEq(vault.freeCollateral(alice), 200 * USDC);
        vm.prank(alice);
        vm.expectRevert(Vault.InsufficientFreeCollateral.selector);
        vault.withdraw(300 * USDC);
    }

    function test_deposit_zero_reverts() public {
        usdc.mint(alice, 1);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.deposit(0);
        vm.stopPrank();
    }

    function test_onlyOperator_canMutateBalances() public {
        _fund(alice, 1_000 * USDC);
        // A random address cannot debit/credit/move — only operators (engine, pool).
        vm.prank(bob);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.debitCollateral(alice, 1);
    }

    function test_setOperator_onlyOwner() public {
        vm.prank(bob);
        vm.expectRevert();
        vault.setOperator(bob, true);
    }
}
