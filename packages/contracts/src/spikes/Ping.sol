// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Ping — Spike A throwaway contract
/// @notice The minimal contract for Spike A: deploy to Arc testnet (paying gas in USDC),
///         write a value, read it back, and emit an event so a WSS subscription has
///         something to fire on. Not part of the venue — purely to confirm tooling +
///         USDC-gas + per-block WSS work unmodified. Safe to discard after the spike.
contract Ping {
    uint256 public value;

    event Pinged(address indexed from, uint256 value, uint256 blockNumber);

    /// @notice Store a value and emit an event (the WSS subscription target).
    function ping(uint256 newValue) external {
        value = newValue;
        emit Pinged(msg.sender, newValue, block.number);
    }
}
