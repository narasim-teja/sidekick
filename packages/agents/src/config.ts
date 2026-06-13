/**
 * Shared config + env loading for the demo agents. Every runnable entry (`agent:long`, the
 * orchestrator, the funding script) loads the repo-root `.env` the same way the engine + spikes do
 * (Bun auto-loads `.env` from CWD, but these run per-package), and resolves the common knobs:
 *
 *   - `AGENTS_MNEMONIC`  — the one BIP-39 seed every agent EOA is derived from (Doc 2 §4.1 keys). If
 *     unset, a deterministic dev seed is used so the demo still runs locally (NEVER for real funds).
 *   - `ENGINE_URL`       — the engine's REST+WS base (default http://localhost:8787).
 *   - `AGENT_MARKET`     — the market the agents trade (default from DEFAULT_MARKET / BTC-PERP).
 *
 * Per-agent sizing lives in `scenario.ts`, not here — this is just the environment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARKET_SYMBOLS, type MarketSymbol } from "@sidekick/sdk";

/**
 * A fixed dev seed so `bun run agent:*` works out-of-the-box with no setup (local demo only). Real
 * runs MUST set `AGENTS_MNEMONIC` to a funded seed — this one is public and holds nothing.
 */
export const DEV_MNEMONIC = "test test test test test test test test test test test junk"; // canonical hardhat dev mnemonic

/** Load the repo-root `.env` into process.env without overwriting existing values. */
export function loadRootEnv(): void {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim();
    }
  } catch {
    /* rely on the ambient env */
  }
}

/** The agents' shared seed (env `AGENTS_MNEMONIC`, else the dev seed). */
export function agentsMnemonic(env: Record<string, string | undefined> = process.env): string {
  return env.AGENTS_MNEMONIC?.trim() || DEV_MNEMONIC;
}

/** Whether we're running on the public dev seed (so scripts can warn before touching real funds). */
export function usingDevMnemonic(env: Record<string, string | undefined> = process.env): boolean {
  return agentsMnemonic(env) === DEV_MNEMONIC;
}

/** The engine REST/WS base URL (env `ENGINE_URL`, else the engine's default port). */
export function engineUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.ENGINE_URL ?? `http://localhost:${env.ENGINE_PORT ?? "8787"}`).replace(/\/$/, "");
}

/** The market the agents trade (env `AGENT_MARKET` / `DEFAULT_MARKET`, else BTC-PERP). */
export function agentMarket(env: Record<string, string | undefined> = process.env): MarketSymbol {
  const raw = env.AGENT_MARKET ?? env.DEFAULT_MARKET ?? "BTC-PERP";
  if (!(MARKET_SYMBOLS as string[]).includes(raw)) {
    throw new Error(`AGENT_MARKET "${raw}" is not a known market (${MARKET_SYMBOLS.join(", ")})`);
  }
  return raw as MarketSymbol;
}

/** A simple `--flag value` / `--flag` CLI arg reader for the scripts. */
export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) return next;
    return ""; // present as a boolean flag
  }
  return fallback;
}

/** True if a boolean `--flag` is present. */
export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
