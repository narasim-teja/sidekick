// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Vault — collateral custody for SideKick (Doc 2 §2.1).
/// @notice Holds the canonical USDC and tracks each account's **free collateral**: un-utilized USDC
///         the account can draw on to open positions or answer margin calls (Doc 1 §3.2). On Arc
///         this is the faucet USDC (also the gas token — Spike C); in tests it is {SideKickUSDC}.
///
///         Money movement is split cleanly:
///           - Users `deposit`/`withdraw` real USDC ↔ their free-collateral balance here.
///           - Withdrawals are limited to free collateral (Doc 1 §3.4: LPs/traders cannot yank
///             capital backing live OI — utilized capital lives as `margin` inside PerpEngine /
///             as `capital` inside Pool, not as free collateral here).
///           - Authorized operators (the PerpEngine and each market's Pool) move USDC *between
///             accounts inside the vault* — no ERC-20 transfer, just balance edits — which is what
///             makes per-block reconciliation cheap. The engine does it during the §4.3 loop
///             (funding, margin-call top-ups, decrement returns); a Pool does it for LP deposit /
///             withdraw and the gap-fund seed.
///
///         All USDC lives here in ONE pot; `freeCollateral` (this contract), position `margin`
///         (PerpEngine), pool `capital` and `gapFund` (Pool) are all *claims* on it. Conservation
///         is the invariant Σ(all claims) == `usdc.balanceOf(vault)` — tested end-to-end.
/// @dev Operators are an allow-list set by the owner at wiring time (the engine + the pools, which
///      reference the vault and so must be authorized post-construction). All amounts USDC 6dp atomic.
contract Vault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The collateral token (canonical Arc USDC; {SideKickUSDC} in tests). 6 decimals.
    IERC20 public immutable usdc;

    /// @notice Addresses permitted to mutate balances outside deposit/withdraw (engine + pools).
    mapping(address => bool) public isOperator;

    /// @notice account → free (un-utilized) collateral, USDC 6dp.
    mapping(address => uint256) public freeCollateral;

    event OperatorSet(address indexed operator, bool allowed);
    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event CollateralDebited(address indexed account, uint256 amount);
    event CollateralCredited(address indexed account, uint256 amount);
    event CollateralMoved(address indexed from, address indexed to, uint256 amount);

    error OnlyOperator();
    error InsufficientFreeCollateral();
    error ZeroAmount();
    error ZeroAddress();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert OnlyOperator();
        _;
    }

    constructor(address usdc_, address initialOwner) Ownable(initialOwner) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
    }

    /// @notice Grant/revoke an operator (the engine and each Pool). Owner-only.
    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    // ── User flows ────────────────────────────────────────────────────────────────

    /// @notice Deposit `amount` USDC into free collateral. Pulls USDC from `msg.sender`.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        freeCollateral[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw `amount` USDC from free collateral to `msg.sender`. Limited to free
    ///         collateral (utilized capital backing live OI cannot be withdrawn — Doc 1 §3.4).
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = freeCollateral[msg.sender];
        if (amount > bal) revert InsufficientFreeCollateral();
        unchecked {
            freeCollateral[msg.sender] = bal - amount;
        }
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ── Engine-only internal accounting (no ERC-20 movement) ───────────────────────

    /// @notice Debit `amount` from `account`'s free collateral (e.g. posting margin on open, or
    ///         paying a margin call). Operator-only. Reverts if free collateral is insufficient.
    function debitCollateral(address account, uint256 amount) external onlyOperator {
        uint256 bal = freeCollateral[account];
        if (amount > bal) revert InsufficientFreeCollateral();
        unchecked {
            freeCollateral[account] = bal - amount;
        }
        emit CollateralDebited(account, amount);
    }

    /// @notice Credit `amount` to `account`'s free collateral (e.g. returning equity on close /
    ///         decrement, or funding received). Operator-only.
    function creditCollateral(address account, uint256 amount) external onlyOperator {
        freeCollateral[account] += amount;
        emit CollateralCredited(account, amount);
    }

    /// @notice Move `amount` of free collateral from one account to another inside the vault, with
    ///         no ERC-20 transfer. Operator-only. The cheap primitive behind per-block settlement.
    function moveCollateral(address from, address to, uint256 amount) external onlyOperator {
        uint256 bal = freeCollateral[from];
        if (amount > bal) revert InsufficientFreeCollateral();
        unchecked {
            freeCollateral[from] = bal - amount;
        }
        freeCollateral[to] += amount;
        emit CollateralMoved(from, to, amount);
    }

    /// @notice Total USDC the vault custodies (sanity / dashboard).
    function totalAssets() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
