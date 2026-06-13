/**
 * Unit helpers for the SDK boundary. The venue speaks two integer units — USDC 6dp atomic and WAD
 * 18dp — and the engine's `fixed/units` already implements the exact parse/format the contracts use.
 * The SDK re-exports those (rather than re-deriving them) so a `notional`/`margin`/`mark` the SDK
 * sends on-chain is byte-identical to what the engine predicts and the contract stores — no drift.
 *
 * Consumers pass human decimal strings ("20", "100.5"); the SDK converts at this one boundary.
 *
 * @see packages/engine/src/fixed/units.ts (the canonical port of SignedWad/USDC units)
 */

export {
  formatUsdc,
  formatWad,
  parseUsdc,
  USDC_ONE,
  WAD,
  wadToFloat,
} from "@sidekick/engine/fixed/units";

import { parseUsdc, WAD } from "@sidekick/engine/fixed/units";

/**
 * Parse a decimal USD price string ("70627.5") to WAD 18dp — the unit `openPosition`/`closePosition`
 * take for `mark`. (USDC `parseUsdc` is 6dp; a mark is a price, not money, so it is WAD.)
 */
export function parseMarkWad(price: string): bigint {
  const trimmed = price.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid price: ${price}`);
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 18) throw new Error(`Price "${price}" has more than 18 decimals`);
  const fracPadded = frac.padEnd(18, "0");
  return BigInt(whole || "0") * WAD + BigInt(fracPadded || "0");
}

/**
 * Convert a collateral amount + leverage into a position notional, both as 6dp USDC bigints.
 * `notional = collateral × leverage`. Leverage is **client-side sugar** — the venue parameterizes a
 * position by `{notional, margin}` and the max leverage is bounded by the market's maintenance
 * fraction `m`, not a venue `leverage` primitive (Doc 2 §5.1 / Doc 3 §8). We frame it honestly.
 */
export function notionalFromLeverage(collateralUsdc: string, leverage: number): bigint {
  if (!(leverage > 0)) throw new Error(`leverage must be > 0, got ${leverage}`);
  const collateral = parseUsdc(collateralUsdc);
  // Scale by leverage in integer space at 1e6 precision to avoid float dust on the notional.
  const levMicro = BigInt(Math.round(leverage * 1e6));
  return (collateral * levMicro) / 1_000_000n;
}
