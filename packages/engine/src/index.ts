/**
 * @sidekick/engine — the off-chain per-block loop.
 *
 *   Layer A (compute): each ~2s Arc block, re-mark every position, recompute skew + funding
 *     (§4.1), check solvency and decrement (§4.2) in the §4.3 order, and emit deltas.
 *   Layer B (value transfer): turn deltas into EIP-3009/x402 nanopayment authorizations
 *     against Gateway unified balances via @circle-fin/x402-batching.
 *
 * The pure math (funding, decrement, loop order) lands in `./core` during Phase 1, where it
 * also powers the in-memory simulation (`bun run sim`). Phase 3 promotes it into a live Hono
 * service reading the real mark via the pluggable oracle adapter and pushing per-block state
 * over WebSocket. This file will become the service entry point.
 *
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 1 (simulation) and Phase 3 (live engine)
 */

export const ENGINE_VERSION = "0.0.0" as const;
