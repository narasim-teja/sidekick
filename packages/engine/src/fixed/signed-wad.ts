/**
 * SignedWad — the bigint mirror of `packages/contracts/src/lib/SignedWad.sol`.
 *
 * Every operation reproduces the Solidity arithmetic *and its truncation* exactly: `wadMul` is
 * `(a·b)/WAD`, `wadDiv` is `(a·WAD)/b`, both truncating toward zero (BigInt `/` truncates toward
 * zero, like Solidity integer division). The fixed-parity tests assert this lib equals the
 * on-chain library for the same inputs, so the engine's per-block compute is integer-identical
 * to what `PerpEngine.checkpoint` will produce.
 *
 * @see packages/contracts/src/lib/SignedWad.sol
 */

import { WAD } from "./units.ts";

/** Absolute value of a signed WAD (or any bigint). Mirrors `SignedWad.abs`. */
export function abs(a: bigint): bigint {
  return a >= 0n ? a : -a;
}

/** Signed multiply in WAD: (a · b) / 1e18, truncated toward zero. Mirrors `SignedWad.wadMul`. */
export function wadMul(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

/** Signed divide in WAD: (a · 1e18) / b, truncated toward zero. Mirrors `SignedWad.wadDiv`. */
export function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("SignedWad: division by zero");
  return (a * WAD) / b;
}

/** Clamp `x` into the inclusive range [lo, hi]. Requires lo ≤ hi. Mirrors `SignedWad.clamp`. */
export function clamp(x: bigint, lo: bigint, hi: bigint): bigint {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** Larger of two signed values. */
export function max(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

/** Smaller of two signed values. */
export function min(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}
