// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IOracleAdapter — the on-chain half of SideKick's pluggable oracle.
/// @notice The common interface every mark source (Stork, Chainlink, …) is read through, so
///         the venue contracts and the CRE workflow are source-agnostic and the source is
///         swappable per-market. Mirrors the off-chain `OracleAdapter` type in the
///         shared package (sidekick/shared). Spike B proves a Stork implementation works on Arc.
interface IOracleAdapter {
    /// @notice A normalized mark reading, source-agnostic.
    /// @param price18 Price scaled to 18 decimals (signed; negative is never expected for USD pairs).
    /// @param timestampMs Observation time in milliseconds since the Unix epoch.
    struct Mark {
        int256 price18;
        uint64 timestampMs;
    }

    /// @notice Read the latest mark for the asset this adapter is configured for.
    /// @return mark The normalized mark (18-decimal price + timestamp).
    function getMark() external view returns (Mark memory mark);

    /// @notice A short identifier for the underlying source, e.g. "stork" or "chainlink".
    function source() external pure returns (string memory);
}
