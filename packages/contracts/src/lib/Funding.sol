// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SignedWad} from "./SignedWad.sol";

/// @title Funding — the §4.1 funding-rate math, ported from `packages/engine/src/core/funding.ts`.
/// @notice Exactly mirrors the simulation:
///
///   S        = (OI_long − OI_short) / (OI_long + OI_short)          // normalized skew [−1,+1] (WAD)
///   S_smooth = λ·S + (1 − λ)·S_smooth_prev                          // EMA, λ ≈ 0.1–0.2 (WAD)
///   rate     = clamp(α · S_smooth · |S_smooth|, −r_max, +r_max)     // convex (γ = 2), clamped (WAD)
///   payment  = N · rate · (Δt / T)                                  // per-block funding on notional N
///
/// @dev Units (Doc 2 Phase 2 fixed-point port):
///        - OI / notional / payment: USDC 6-decimal atomic (the venue's money unit).
///        - skew, S_smooth, rate, α, λ: WAD (1e18) dimensionless.
///      `α` scales with `r_max` (Phase-1 finding) — the convex region α·S² is only visible up to
///      S* = √(r_max/α), so α ≈ r_max keeps saturation at S = ±1 (circuit-breaker, not the operating
///      point). The registry stores α directly, already at that scale; this library does not re-derive it.
library Funding {
    using SignedWad for int256;

    /// @notice Per-block funding parameters, all WAD except the period ratio inputs.
    struct Params {
        int256 alpha; // funding scale α (WAD), ~ r_max in magnitude
        int256 rMax; // per-block rate clamp r_max (WAD), ≥ 0
        int256 lambda; // EMA smoothing λ (WAD), ∈ (0, 1]
    }

    /// @notice Normalized skew S ∈ [−1, +1] in WAD. Returns 0 when there is no open interest.
    /// @param oiLong  Long open interest (USDC 6dp).
    /// @param oiShort Short open interest (USDC 6dp).
    function skew(uint256 oiLong, uint256 oiShort) internal pure returns (int256) {
        uint256 total = oiLong + oiShort;
        if (total == 0) return 0;
        // (long − short) / (long + short), lifted to WAD. Numerator is signed; cast is safe for
        // any realistic OI (well below int256 range).
        int256 num = int256(oiLong) - int256(oiShort);
        return num.wadDiv(int256(total));
    }

    /// @notice One EMA step: S_smooth = λ·S + (1 − λ)·S_smooth_prev. All WAD.
    function smoothSkew(int256 s, int256 sSmoothPrev, int256 lambda) internal pure returns (int256) {
        int256 oneMinusLambda = SignedWad.WAD - lambda;
        return lambda.wadMul(s) + oneMinusLambda.wadMul(sSmoothPrev);
    }

    /// @notice Convex, clamped per-period funding rate: clamp(α · S_smooth · |S_smooth|, −r_max, +r_max).
    ///         The `S·|S|` form is the γ = 2 convex shape (flat near balance, quadratic toward ±1). WAD.
    function fundingRate(int256 sSmooth, Params memory p) internal pure returns (int256) {
        // α · (S_smooth · |S_smooth|): two WAD muls, so the result is WAD·WAD/WAD = WAD.
        int256 convex = sSmooth.wadMul(sSmooth.abs());
        int256 raw = p.alpha.wadMul(convex);
        return raw.clamp(-p.rMax, p.rMax);
    }

    /// @notice Per-block funding payment on a position of notional `N`: N · rate · (Δt / T).
    /// @param notional      Position notional at the current mark (USDC 6dp, ≥ 0).
    /// @param rate          Per-period funding rate from {fundingRate} (WAD).
    /// @param blockSeconds  Block cadence Δt (seconds).
    /// @param periodSeconds Funding period T (seconds).
    /// @return payment Signed funding magnitude in USDC 6dp (always ≥ 0 here; the caller applies the
    ///         §4.1 sign: rate > 0 → longs pay, shorts/pool receive). Magnitude only — sign is the
    ///         position side's responsibility, exactly as in the simulation's `fundingPayment`.
    function fundingPayment(uint256 notional, int256 rate, uint256 blockSeconds, uint256 periodSeconds)
        internal
        pure
        returns (int256 payment)
    {
        // N · rate, then scale by the (Δt / T) period fraction. `notional · rate` is WAD-scaled USDC;
        // dividing by WAD returns USDC, then `· Δt / T` applies the block fraction. Order chosen to
        // keep the intermediate from losing precision (multiply before the period division).
        int256 nRate = int256(notional).wadMul(rate); // USDC 6dp (rate de-scaled)
        payment = (nRate * int256(blockSeconds)) / int256(periodSeconds);
    }
}
