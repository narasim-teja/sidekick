/**
 * Engine runtime constants — the cadence values, as bigints, matching the on-chain immutables
 * (PerpEngine.blockSeconds / fundingPeriodSeconds) so the off-chain funding payment equals the
 * on-chain one. Sourced from the shared package's `BLOCK_SECONDS` / `FUNDING_PERIOD_SECONDS`.
 *
 * @see packages/shared/src/markets.ts (BLOCK_SECONDS, FUNDING_PERIOD_SECONDS)
 * @see packages/contracts/script/Deploy.s.sol (the same values passed to the PerpEngine ctor)
 */

import { BLOCK_SECONDS, FUNDING_PERIOD_SECONDS } from "@sidekick/shared";

/** Arc block cadence Δt (seconds) as a bigint, for `N·rate·(Δt/T)`. */
export const BLOCK_SECONDS_BIG = BigInt(BLOCK_SECONDS);

/** Funding period T (seconds) as a bigint. */
export const FUNDING_PERIOD_BIG = BigInt(FUNDING_PERIOD_SECONDS);
