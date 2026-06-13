/**
 * Fixed-point units for the live engine (Phase 3) — the integer representation the on-chain
 * venue uses, so the off-chain compute predicts {@link https PerpEngine.checkpoint} exactly.
 *
 * The Phase-1 simulation is float (`number`) — fine for a constants sweep, but the live loop
 * *triggers a real on-chain checkpoint*, so it must compute in the SAME integer units the
 * contracts do, with the SAME truncating integer division, or the off-chain prediction drifts
 * from on-chain truth (precisely the PnL-double-count / conservation class Doc 1 §4.3 warns
 * against). So the live path uses `bigint` throughout:
 *
 *   - **USDC money** — 6-decimal atomic integers (the venue's money unit; 1 USDC = 1_000_000).
 *   - **Mark + dimensionless params** (skew, rate, m, α, λ) — WAD, 1e18 fixed point.
 *   - `k` — a plain integer.
 *
 * Solidity integer division truncates toward zero; BigInt `/` in JS/TS does too, so the fixed/*
 * ports are bit-for-bit identical to `src/lib/*.sol` (asserted by the parity tests).
 *
 * @see packages/contracts/src/lib/SignedWad.sol (the conventions this mirrors)
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 2 fixed-point port note
 */

/** 1.0 in WAD (1e18) fixed point — matches `SignedWad.WAD`. */
export const WAD = 1_000_000_000_000_000_000n;

/** USDC has 6 decimals; 1 USDC = 1e6 atomic units. */
export const USDC_DECIMALS = 6;
export const USDC_ONE = 1_000_000n;

/** 1e12 — the scale between 6dp USDC and 18dp WAD (matches PerpEngine.USDC_TO_WAD). */
export const USDC_TO_WAD = 1_000_000_000_000n;

/**
 * 1e30 = 1e18 · 1e12 — converts `entryNotional(6dp) · 1e30 / mark(18dp)` to a base quantity in
 * WAD, matching PerpEngine.NOTIONAL_TO_QTY. Used only where a base-asset qty is needed.
 */
export const NOTIONAL_TO_QTY = 1_000_000_000_000_000_000_000_000_000_000n;

/** Parse a decimal USDC string (e.g. "100.5") to 6dp atomic bigint. Rejects > 6 decimals. */
export function parseUsdc(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid USDC amount: ${amount}`);
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`USDC has ${USDC_DECIMALS} decimals; "${amount}" has too many`);
  }
  const fracPadded = frac.padEnd(USDC_DECIMALS, "0");
  return BigInt(whole ?? "0") * USDC_ONE + BigInt(fracPadded || "0");
}

/** Format a 6dp atomic USDC bigint as a decimal string (e.g. 100_500000n → "100.5"). */
export function formatUsdc(atomic: bigint): string {
  const neg = atomic < 0n;
  const abs = neg ? -atomic : atomic;
  const whole = abs / USDC_ONE;
  const frac = (abs % USDC_ONE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/** Format an 18dp WAD bigint as a decimal string (e.g. a mark price). */
export function formatWad(wad: bigint): string {
  const neg = wad < 0n;
  const abs = neg ? -wad : wad;
  const whole = abs / WAD;
  const frac = (abs % WAD).toString().padStart(18, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/**
 * Convert a float (the Phase-1 sim's representation) to WAD bigint, rounding to 12 decimal
 * places first to clear IEEE-754 dust — the same approach `gen-params.ts` uses so the engine's
 * params equal the generated `Params.sol` constants exactly.
 */
export function floatToWad(x: number): bigint {
  // 12 sig-decimals is plenty for m/α/λ/r_max (the smallest is 0.0005) and clears float noise.
  const scaled = Math.round(x * 1e12);
  return (BigInt(scaled) * WAD) / 1_000_000_000_000n;
}

/** Convert a float USDC amount to 6dp atomic bigint (rounded). For test/seed convenience. */
export function floatToUsdc(x: number): bigint {
  return BigInt(Math.round(x * Number(USDC_ONE)));
}

/** Convert a 6dp atomic USDC bigint to a float (lossy — display/metrics only, never the loop). */
export function usdcToFloat(atomic: bigint): number {
  return Number(atomic) / Number(USDC_ONE);
}

/** Convert an 18dp WAD bigint to a float (lossy — display/metrics only, never the loop). */
export function wadToFloat(wad: bigint): number {
  return Number(wad) / Number(WAD);
}
