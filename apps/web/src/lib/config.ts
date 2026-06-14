/**
 * Runtime configuration, read from `NEXT_PUBLIC_*` env at build time (static export inlines these).
 *
 *   NEXT_PUBLIC_ENGINE_URL  — the engine REST base. Default http://localhost:8787 (the engine's port).
 *   NEXT_PUBLIC_ENGINE_WS   — the WS stream URL. Default = engine URL with http→ws + `/ws`.
 *   NEXT_PUBLIC_AGENTS      — optional JSON `{address: role}` map for labelling demo agents.
 *
 * For a Vercel deploy, set NEXT_PUBLIC_ENGINE_URL to the hosted engine; locally the defaults Just Work
 * against `bun run engine`.
 */

const DEFAULT_ENGINE_URL = "http://localhost:8787";

export function engineUrl(): string {
  return (process.env.NEXT_PUBLIC_ENGINE_URL ?? DEFAULT_ENGINE_URL).replace(/\/$/, "");
}

export function engineWsUrl(): string {
  if (process.env.NEXT_PUBLIC_ENGINE_WS) return process.env.NEXT_PUBLIC_ENGINE_WS;
  return `${engineUrl().replace(/^http/, "ws")}/ws`;
}

/** How long (ms) to wait for the live engine before falling back to the demo replay. */
export const LIVE_PROBE_TIMEOUT_MS = 2500;

/**
 * Replay cadence (ms). Slightly faster than Arc's ~2s block so the demo arc (build → skew → decrement →
 * MM → recovery) reaches its beats quickly without feeling unnaturally fast — it still reads as a
 * per-block loop, just a brisk one.
 */
export const REPLAY_BLOCK_MS = 1400;
