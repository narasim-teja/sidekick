/**
 * Engine runtime constants — the cadence values, as bigints, matching the on-chain immutables
 * (PerpEngine.blockSeconds / fundingPeriodSeconds) so the off-chain funding payment equals the
 * on-chain one. Sourced from the shared package's `BLOCK_SECONDS` / `FUNDING_PERIOD_SECONDS`.
 *
 * @see packages/shared/src/markets.ts (BLOCK_SECONDS, FUNDING_PERIOD_SECONDS)
 * @see packages/contracts/script/Deploy.s.sol (the same values passed to the PerpEngine ctor)
 */

import { BLOCK_SECONDS, FUNDING_PERIOD_SECONDS } from "@sidekick/shared";

/**
 * Engine version — surfaced in the WS `hello` frame and the `GET /venue` descriptor so a consumer
 * can pin the engine it's talking to. Lives here (not index.ts) so `service.ts` can import it without
 * a cycle. Bump on a payload/route change.
 */
export const ENGINE_VERSION = "0.3.1" as const;

/** Arc block cadence Δt (seconds) as a bigint, for `N·rate·(Δt/T)`. */
export const BLOCK_SECONDS_BIG = BigInt(BLOCK_SECONDS);

/** Funding period T (seconds) as a bigint. */
export const FUNDING_PERIOD_BIG = BigInt(FUNDING_PERIOD_SECONDS);
