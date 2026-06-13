// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title SideKickUSDC — a 6-decimal mock USDC for LOCAL Foundry tests and local deploys only.
/// @notice On Arc testnet the venue custodies the **canonical Arc testnet USDC** (the faucet token,
///         which is also the gas token — Spike C). This mock exists solely so the contracts can be
///         unit/fuzz-tested in isolation with a mintable 6-dp token; the deploy script wires the
///         real USDC address on Arc and never deploys this. Named explicitly as a test artifact so
///         it is never mistaken for the production collateral (Doc 2 §2.3: no `mUSDC`-style naming
///         leaking into the venue — the LP token is the branded `slpUSDC`; this is test scaffolding).
/// @dev Permissionless `mint` — acceptable because it is test-only and never deployed to a network
///      that matters.
contract SideKickUSDC is ERC20 {
    constructor() ERC20("SideKick Test USDC", "tUSDC") {}

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `amount` (6dp atomic) to `to`. Test-only faucet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
