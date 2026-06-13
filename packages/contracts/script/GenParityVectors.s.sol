// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {Funding} from "../src/lib/Funding.sol";
import {Decrement} from "../src/lib/Decrement.sol";
import {SignedWad} from "../src/lib/SignedWad.sol";

/// @title GenParityVectors — emit a JSON fixture of (input → output) vectors for the math libs.
/// @notice The engine's `src/fixed/*` is a bigint mirror of these Solidity libraries. To prove the
///         off-chain compute equals the on-chain `checkpoint` bit-for-bit, this script evaluates the
///         libraries over a fixed grid (incl. the convex shape, the clamp, EMA steps, the decrement
///         branches, and gap edges) and writes the authoritative outputs to a JSON fixture. The TS
///         parity test (`src/fixed/parity.test.ts`) then asserts the port reproduces every vector —
///         deterministic and offline, no live RPC needed per test run.
///
/// @dev Run: `forge script script/GenParityVectors.s.sol` (writes to test/fixtures/parity-vectors.json).
///      Re-run if the libraries change; the fixture is committed so the TS test is hermetic.
contract GenParityVectors is Script {
    int256 constant WAD = 1e18;
    uint256 constant USDC = 1e6;
    int256 constant USDC_I = 1e6; // signed USDC unit for the equity/notional grids

    // Phase-1 swept params (mirror of generated Params.sol).
    int256 constant M = 0.01e18;
    int256 constant ALPHA = 0.0005e18;
    int256 constant LAMBDA = 0.08e18;
    int256 constant R_MAX = 0.0005e18;
    uint256 constant BLOCK_SECONDS = 2;
    uint256 constant PERIOD_SECONDS = 8 hours;

    string out;

    function run() external {
        out = "{\n";

        _emitSkew();
        _emitSmoothSkew();
        _emitFundingRate();
        _emitFundingPayment();
        _emitIsHealthy();
        _emitMarginCall();
        _emitDecrement();

        out = string.concat(out, '  "_meta": { "block_seconds": 2, "period_seconds": 28800 }\n');
        out = string.concat(out, "}\n");

        vm.writeFile("test/fixtures/parity-vectors.json", out);
    }

    function _params() internal pure returns (Funding.Params memory) {
        return Funding.Params({alpha: ALPHA, rMax: R_MAX, lambda: LAMBDA});
    }

    function _emitSkew() internal {
        // [oiLong, oiShort] grids spanning balanced, all-one-side, partial.
        uint256[2][7] memory g = [
            [uint256(0), uint256(0)],
            [uint256(100_000 * USDC), uint256(100_000 * USDC)],
            [uint256(100_000 * USDC), uint256(0)],
            [uint256(0), uint256(100_000 * USDC)],
            [uint256(150_000 * USDC), uint256(50_000 * USDC)],
            [uint256(333_333 * USDC), uint256(666_667 * USDC)],
            [uint256(1), uint256(3)]
        ];
        out = string.concat(out, '  "skew": [\n');
        for (uint256 i = 0; i < g.length; i++) {
            int256 r = Funding.skew(g[i][0], g[i][1]);
            out = string.concat(
                out,
                "    { \"oiLong\": ",
                vm.toString(g[i][0]),
                ", \"oiShort\": ",
                vm.toString(g[i][1]),
                ", \"out\": ",
                vm.toString(r),
                i + 1 < g.length ? " },\n" : " }\n"
            );
        }
        out = string.concat(out, "  ],\n");
    }

    function _emitSmoothSkew() internal {
        int256[2][6] memory g = [
            [WAD, int256(0)],
            [WAD, int256(0.08e18)],
            [-WAD, int256(0)],
            [int256(0.5e18), int256(0.1e18)],
            [int256(0), int256(0.5e18)],
            [-int256(0.3e18), int256(0.2e18)]
        ];
        out = string.concat(out, '  "smoothSkew": [\n');
        for (uint256 i = 0; i < g.length; i++) {
            int256 r = Funding.smoothSkew(g[i][0], g[i][1], LAMBDA);
            out = string.concat(
                out,
                "    { \"s\": ",
                vm.toString(g[i][0]),
                ", \"prev\": ",
                vm.toString(g[i][1]),
                ", \"lambda\": ",
                vm.toString(LAMBDA),
                ", \"out\": ",
                vm.toString(r),
                i + 1 < g.length ? " },\n" : " }\n"
            );
        }
        out = string.concat(out, "  ],\n");
    }

    function _emitFundingRate() internal {
        int256[8] memory sgrid = [
            int256(0),
            int256(0.1e18),
            int256(0.5e18),
            WAD,
            -WAD,
            -int256(0.5e18),
            int256(0.25e18),
            int256(0.9e18)
        ];
        out = string.concat(out, '  "fundingRate": [\n');
        for (uint256 i = 0; i < sgrid.length; i++) {
            int256 r = Funding.fundingRate(sgrid[i], _params());
            out = string.concat(
                out,
                "    { \"sSmooth\": ",
                vm.toString(sgrid[i]),
                ", \"alpha\": ",
                vm.toString(ALPHA),
                ", \"rMax\": ",
                vm.toString(R_MAX),
                ", \"out\": ",
                vm.toString(r),
                " },\n" // always comma — an extra clamp vector follows the grid.
            );
        }
        // One vector where the clamp must bite (alpha > rMax).
        Funding.Params memory pBig = Funding.Params({alpha: 0.002e18, rMax: R_MAX, lambda: LAMBDA});
        int256 clamped = Funding.fundingRate(WAD, pBig);
        out = string.concat(
            out,
            "    { \"sSmooth\": ",
            vm.toString(WAD),
            ", \"alpha\": ",
            vm.toString(int256(0.002e18)),
            ", \"rMax\": ",
            vm.toString(R_MAX),
            ", \"out\": ",
            vm.toString(clamped),
            " }\n"
        );
        out = string.concat(out, "  ],\n");
    }

    function _emitFundingPayment() internal {
        uint256[3] memory notionals = [uint256(10_000 * USDC), uint256(100_000 * USDC), uint256(2 * USDC)];
        int256[3] memory rates = [R_MAX, int256(0), int256(0.000125e18)];
        out = string.concat(out, '  "fundingPayment": [\n');
        bool first = true;
        for (uint256 i = 0; i < notionals.length; i++) {
            for (uint256 j = 0; j < rates.length; j++) {
                int256 r = Funding.fundingPayment(notionals[i], rates[j], BLOCK_SECONDS, PERIOD_SECONDS);
                out = string.concat(out, first ? "    " : ",\n    ");
                first = false;
                out = string.concat(
                    out,
                    "{ \"notional\": ",
                    vm.toString(notionals[i]),
                    ", \"rate\": ",
                    vm.toString(rates[j]),
                    ", \"out\": ",
                    vm.toString(r),
                    " }"
                );
            }
        }
        out = string.concat(out, "\n  ],\n");
    }

    function _emitIsHealthy() internal {
        // [equity, notional] (6dp); m = 0.01.
        int256[2][5] memory g = [
            [int256(100) * USDC_I, int256(10_000) * USDC_I], // E=100, m·N=100 → healthy (==)
            [int256(99) * USDC_I, int256(10_000) * USDC_I], // E=99 < 100 → unhealthy
            [int256(60) * USDC_I, int256(10_000) * USDC_I], // decrement zone
            [int256(0), int256(10_000) * USDC_I], // E=0 → unhealthy (gap)
            [-int256(5) * USDC_I, int256(10_000) * USDC_I] // underwater
        ];
        out = string.concat(out, '  "isHealthy": [\n');
        for (uint256 i = 0; i < g.length; i++) {
            bool r = Decrement.isHealthy(g[i][0], uint256(g[i][1]), M);
            out = string.concat(
                out,
                "    { \"equity\": ",
                vm.toString(g[i][0]),
                ", \"notional\": ",
                vm.toString(uint256(g[i][1])),
                ", \"m\": ",
                vm.toString(M),
                ", \"out\": ",
                r ? "true" : "false",
                i + 1 < g.length ? " },\n" : " }\n"
            );
        }
        out = string.concat(out, "  ],\n");
    }

    function _emitMarginCall() internal {
        int256[2][4] memory g = [
            [int256(100) * USDC_I, int256(10_000) * USDC_I], // 0 (healthy)
            [int256(60) * USDC_I, int256(10_000) * USDC_I], // 40
            [int256(0), int256(10_000) * USDC_I], // 100
            [-int256(5) * USDC_I, int256(10_000) * USDC_I] // 105
        ];
        out = string.concat(out, '  "marginCall": [\n');
        for (uint256 i = 0; i < g.length; i++) {
            uint256 r = Decrement.marginCall(g[i][0], uint256(g[i][1]), M);
            out = string.concat(
                out,
                "    { \"equity\": ",
                vm.toString(g[i][0]),
                ", \"notional\": ",
                vm.toString(uint256(g[i][1])),
                ", \"m\": ",
                vm.toString(M),
                ", \"out\": ",
                vm.toString(r),
                i + 1 < g.length ? " },\n" : " }\n"
            );
        }
        out = string.concat(out, "  ],\n");
    }

    function _emitDecrement() internal {
        int256[2][5] memory g = [
            [int256(100) * USDC_I, int256(10_000) * USDC_I], // healthy
            [int256(60) * USDC_I, int256(10_000) * USDC_I], // decrement → N'=6000
            [int256(33) * USDC_I, int256(10_000) * USDC_I], // decrement → N'=3300
            [int256(0), int256(10_000) * USDC_I], // gap, badDebt 0
            [-int256(5) * USDC_I, int256(10_000) * USDC_I] // gap, badDebt 5
        ];
        out = string.concat(out, '  "applyDecrement": [\n');
        for (uint256 i = 0; i < g.length; i++) {
            Decrement.Outcome memory o = Decrement.applyDecrement(g[i][0], uint256(g[i][1]), M);
            out = string.concat(
                out,
                "    { \"equity\": ",
                vm.toString(g[i][0]),
                ", \"notional\": ",
                vm.toString(uint256(g[i][1])),
                ", \"m\": ",
                vm.toString(M),
                ", \"kind\": ",
                vm.toString(uint256(o.kind)),
                ", \"newNotional\": ",
                vm.toString(o.newNotional),
                ", \"closedNotional\": ",
                vm.toString(o.closedNotional),
                ", \"badDebt\": ",
                vm.toString(o.badDebt),
                i + 1 < g.length ? " },\n" : " }\n"
            );
        }
        out = string.concat(out, "  ],\n");
    }
}
