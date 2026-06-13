// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LPToken (slpUSDC) — the branded LP share token for a SideKick pool.
/// @notice One per market pool. Minted to an LP on deposit and burned on withdrawal, representing a
///         pro-rata claim on that pool's capital (Doc 1 §3.1, §7: "pool capital / LP claim value").
///         Deliberately a real, cleanly-named ERC-20 (`slpUSDC`, NOT a mock name) per Doc 2 §2.3.
/// @dev Mint/burn are gated to the owning Pool contract (set once as `pool` at construction). Shares
///      are 6-decimal to line up with the USDC the pool holds (1:1 at genesis seeding).
contract LPToken is ERC20 {
    /// @notice The Pool authorized to mint/burn these shares.
    address public immutable pool;

    /// @notice Thrown when a non-pool address calls a mint/burn entry point.
    error OnlyPool();

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    /// @param name_  Display name, e.g. "SideKick BTC-PERP LP".
    /// @param symbol_ Symbol, e.g. "slpUSDC-BTC".
    /// @param pool_  The Pool contract permitted to mint/burn.
    constructor(string memory name_, string memory symbol_, address pool_) ERC20(name_, symbol_) {
        pool = pool_;
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `shares` (6dp) to `to`. Pool-only.
    function mint(address to, uint256 shares) external onlyPool {
        _mint(to, shares);
    }

    /// @notice Burn `shares` (6dp) from `from`. Pool-only.
    function burn(address from, uint256 shares) external onlyPool {
        _burn(from, shares);
    }
}
