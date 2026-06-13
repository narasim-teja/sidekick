/**
 * Fixed-point core for the live engine (Phase 3) — bigint ports of the on-chain math libraries,
 * computing in the venue's exact integer units (USDC 6dp, WAD 18dp) so the off-chain per-block
 * loop predicts {@link https PerpEngine.checkpoint} bit-for-bit. The Phase-1 `src/core` floats stay
 * for the simulation/sweep; this is the path that drives the real chain.
 *
 * @see packages/contracts/src/lib (the Solidity these mirror)
 */

export * from "./decrement.ts";
export * from "./funding.ts";
export * from "./params.ts";
export * from "./signed-wad.ts";
export * from "./units.ts";
