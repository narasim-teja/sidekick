/**
 * Deterministic price paths for the simulation. Everything is seeded so a scenario is exactly
 * reproducible run to run (required for a constants sweep to be comparable, and so the demo
 * evidence is stable). No `Math.random`.
 *
 * The mark is what the engine re-marks against each block; in the live venue it comes from the
 * pluggable oracle adapter (Stork/Chainlink), here it is synthetic.
 */

/** A tiny deterministic PRNG (mulberry32) — fast, seedable, good enough for synthetic paths. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller, driven by a [0,1) PRNG. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A geometric-Brownian-motion-ish path: each block the mark moves by a small drift plus a
 * gaussian shock scaled by `volPerBlock` (as a fraction of price). Deterministic for a seed.
 * `gaps` injects single-block jumps: at block `at`, multiply the mark by `factor` (e.g. 0.85
 * for a −15% gap) to exercise the gap-event branch.
 */
export function gbmPath(opts: {
  blocks: number;
  start: number;
  driftPerBlock?: number;
  volPerBlock?: number;
  seed?: number;
  gaps?: { at: number; factor: number }[];
}): number[] {
  const drift = opts.driftPerBlock ?? 0;
  const vol = opts.volPerBlock ?? 0.0005;
  const rand = mulberry32(opts.seed ?? 1);
  const gaps = new Map((opts.gaps ?? []).map((g) => [g.at, g.factor]));
  const path: number[] = [opts.start];
  for (let b = 1; b <= opts.blocks; b += 1) {
    const prev = path[b - 1] as number;
    const shock = vol * gaussian(rand);
    let next = prev * (1 + drift + shock);
    const gap = gaps.get(b);
    if (gap !== undefined) next *= gap;
    path.push(Math.max(next, 0.01));
  }
  return path;
}

/** A flat (constant) price path — isolates funding/decrement behavior from price noise. */
export function flatPath(blocks: number, price: number): number[] {
  return Array.from({ length: blocks + 1 }, () => price);
}
