/**
 * Display formatting. The engine sends amounts as decimal strings and rates/skew as numbers; these
 * helpers turn them into legible, consistently-rounded display strings. No bigint math here, the
 * payload already crossed the 6dp/WAD boundary in the engine (Doc 1 §5), so this is pure presentation.
 */

/** Parse a (possibly signed) decimal string to a JS number for display math. NaN-safe → 0. */
export function num(s: string | number | undefined | null): number {
  if (s === undefined || s === null) return 0;
  const n = typeof s === "number" ? s : Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Format a USDC amount with a `$` and adaptive precision (more decimals for tiny nanopayments). */
export function usd(value: string | number, opts: { sign?: boolean } = {}): string {
  const n = num(value);
  const abs = Math.abs(n);
  let decimals = 2;
  if (abs > 0 && abs < 0.01)
    decimals = 6; // sub-cent nanopayments
  else if (abs < 1) decimals = 4;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const s = `$${body}`;
  if (opts.sign) return `${n < 0 ? "−" : "+"}${s}`;
  return n < 0 ? `−${s}` : s;
}

/** Compact USD for headline numbers (e.g. $12.3k, $1.2M). */
export function usdCompact(value: string | number): string {
  const n = num(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Format a mark price (USD), adaptive precision by magnitude. */
export function mark(value: string | number): string {
  const n = num(value);
  const decimals = n >= 1000 ? 2 : n >= 1 ? 3 : 5;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** Format the per-period funding rate as basis points (rate is per the funding period T). */
export function rateBps(rate: number): string {
  const bps = rate * 10_000;
  const sign = bps > 0 ? "+" : bps < 0 ? "−" : "";
  return `${sign}${Math.abs(bps).toFixed(3)} bps`;
}

/** Skew as a signed percentage. */
export function skewPct(skew: number): string {
  const pct = skew * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** A 0..1 ratio clamped, for gauges/bars. */
export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Time-ago in compact form (e.g. 3s, 2m). */
export function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 1000) return "now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  return `${Math.floor(d / 3_600_000)}h`;
}
