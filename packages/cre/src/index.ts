/**
 * @sidekick/cre — the Chainlink CRE workflow (Layer C). PRIMARY bounty target ($6k).
 *
 * One workflow, two jobs, run at the Layer C cadence (every N blocks / minutes, NOT per-block):
 *   1. Fetch + verify the mark via the pluggable adapter (Stork OR Chainlink, per-market).
 *   2. Validate the accumulated off-chain state from the engine.
 *   3. Post the authoritative on-chain state transition to PerpEngine on Arc.
 *
 * Built in Phase 6, on top of a fully-working Arc + Circle spine. Uses the CRE TypeScript SDK
 * + CRE CLI (simulation via CLI qualifies for the bounty).
 *
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 6
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §6 (why CRE, and why not for the hot loop)
 */

export const CRE_VERSION = "0.0.0" as const;
