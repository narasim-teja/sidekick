/**
 * @sidekick/agents — autonomous demo agents (Doc 2 Phase 4), all built on @sidekick/sdk:
 *   - long / short      — open positions, answer per-block margin calls, hold/adjust on funding
 *   - mm                — watch pool skew, provide the balancing side, harvest rebate + carry
 *   - funding-strategy  — the hero: hold PURE funding exposure (impossible on a human venue)
 *   - dark              — go deliberately silent to demonstrate smooth decrement (not liquidation)
 *
 * Stubbed for Phase 0; implemented in Phase 4 once the SDK (Phase 5 surface) and engine are live.
 */

export const AGENTS_VERSION = "0.0.0" as const;
