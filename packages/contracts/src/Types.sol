// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Types — shared data shapes for the SideKick venue contracts.
/// @notice Centralizes the structs/enums that more than one contract refers to, so the unit
///         conventions (USDC 6dp money, WAD 1e18 dimensionless + mark) are stated once.

/// @notice Position direction. `Flat` = no open position (the POC is one position per account
///         per market, isolated — Doc 1 §3.4).
enum Side {
    Flat,
    Long,
    Short
}

/// @notice One open position, stored in `entryNotional + entryMark` form (no separate base-asset
///         `qty` unit — Doc 2 Phase 2 fixed-point port). This is algebraically identical to the
///         simulation's `qty · entryMark` representation:
///           qty                = entryNotional / entryMark
///           notionalAt(mark)   = entryNotional · mark / entryMark
///           pricePnl(mark)     = signedQty · (mark − entryMark)
///                              = entryNotional · (mark − entryMark) / entryMark
///         so storing `(entryNotional, entryMark)` recovers every quantity the §4.3 loop needs.
/// @dev Units: `entryNotional` and `margin` are USDC 6dp; `entryMark` is the mark in WAD (18dp),
///      matching {IOracleAdapter.Mark}.price18. `margin` is the collateral backing this position;
///      equity = margin + pricePnl(mark) + accrued funding (funding folded into `margin` per block).
struct Position {
    Side side;
    uint256 entryNotional; // USDC 6dp at entry (N)
    uint256 entryMark; // mark price WAD 18dp at entry / last re-base
    uint256 margin; // USDC 6dp collateral posted against this position
}

/// @notice Funding + risk parameters for one market — the on-chain mirror of `MarketParams` in
///         the shared package's `MarketParams` (chosen by the Phase-1 sweep). All dimensionless terms in WAD.
/// @dev `alpha` already carries the `α ≈ r_max` scaling from the Phase-1 finding (the registry
///      stores the scaled value; nothing re-derives it on-chain).
struct MarketParams {
    int256 m; // maintenance fraction (WAD), e.g. 0.01e18 = 1%
    int256 alpha; // funding scale α (WAD), ~ rMax in magnitude
    int256 lambda; // EMA smoothing λ (WAD), ∈ (0, 1]
    int256 rMax; // per-block funding-rate clamp (WAD), ≥ 0
    uint256 k; // OI-cap multiplier (integer): pool exposure ≤ k · capital
}
