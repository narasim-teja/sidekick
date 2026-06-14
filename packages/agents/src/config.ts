/**
 * Shared config + env loading for the demo agents. Every runnable entry (`agent:long`, the
 * orchestrator, the fund/close-all/register-identities scripts) loads the repo-root `.env` the same way
 * the engine + spikes do (Bun auto-loads `.env` from CWD, but these run per-package), and resolves the
 * common knobs:
 *
 *   - `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` + per-role wallet ids — the fleet's signing custody
 *     (Circle developer-controlled MPC wallets; no raw key in-process). REQUIRED — see {@link circleFleetConfig}.
 *   - `ENGINE_URL`       — the engine's REST+WS base (default http://localhost:8787).
 *   - `AGENT_MARKET`     — the market the agents trade (default from DEFAULT_MARKET / BTC-PERP).
 *
 * Per-agent sizing lives in `scenario.ts`, not here — this is just the environment.
 *
 * Custody model (Doc 1 §8 / the Circle Agent Stack ask): the demo fleet signs through Circle MPC
 * wallets ONLY. There is no HD/mnemonic fallback — each role maps to a Circle `walletId` and the
 * operator's entity secret authorizes signing. {@link circleSkForRole} is the one seam every entry
 * uses to turn a role into a Circle-backed `SideKick` client.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AgentRole, MARKET_SYMBOLS, type MarketSymbol, SideKick } from "@sidekick/sdk";
import { circleSigner } from "@sidekick/sdk/circle";

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
      if (process.env[k] === undefined) process.env[k] = unquote(t.slice(i + 1).trim());
    }
  } catch {
    /* rely on the ambient env */
  }
}

/** Strip a single pair of surrounding single/double quotes from an env value (dotenv behavior). */
function unquote(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
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

/** The fleet's Circle custody config: account creds + a role→walletId resolver. */
export interface CircleFleetConfig {
  apiKey: string;
  entitySecret: string;
  /** The Circle developer-controlled wallet id for a role, or undefined if unmapped. */
  walletIdFor: (role: AgentRole) => string | undefined;
}

/** The five demo roles, in order, for mapping a `CIRCLE_AGENT_WALLET_IDS` comma list. */
const FLEET_ROLES: readonly AgentRole[] = ["long", "short", "mm", "funding", "dark"] as const;

/**
 * Circle developer-controlled wallet config for the demo fleet, if present. Each role maps to a Circle
 * wallet id so the fleet signs via MPC (no raw keys) — the only custody path for the fleet. Provide ids
 * either per-role (`CIRCLE_WALLET_ID_LONG`, `_SHORT`, `_MM`, `_FUNDING`, `_DARK`) or as one ordered
 * comma list (`CIRCLE_AGENT_WALLET_IDS=id1,id2,…` mapped to the roles in order). Returns null when
 * Circle isn't configured (no API key/secret, or no wallet ids at all). Callers should use
 * {@link requireCircleFleet} to fail loud rather than silently no-op.
 */
export function circleFleetConfig(
  env: Record<string, string | undefined> = process.env,
): CircleFleetConfig | null {
  const apiKey = env.CIRCLE_API_KEY?.trim();
  const entitySecret = env.CIRCLE_ENTITY_SECRET?.trim();
  if (!apiKey || !entitySecret) return null;

  const list = env.CIRCLE_AGENT_WALLET_IDS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const byOrder = new Map<AgentRole, string>();
  if (list?.length) {
    FLEET_ROLES.forEach((r, i) => {
      if (list[i]) byOrder.set(r, list[i] as string);
    });
  }

  const walletIdFor = (role: AgentRole): string | undefined =>
    env[`CIRCLE_WALLET_ID_${role.toUpperCase()}`]?.trim() || byOrder.get(role);

  // Treat the fleet as Circle-backed if at least one role has a wallet id (per-role requireness is
  // enforced in requireCircleFleet / circleSkForRole, which name the specific missing role).
  const anyId = FLEET_ROLES.some((r) => walletIdFor(r));
  return anyId ? { apiKey, entitySecret, walletIdFor } : null;
}

/**
 * Resolve the fleet's Circle config or throw with a precise, actionable message. The demo fleet has NO
 * raw-key fallback — Circle MPC wallets are the only custody path — so every entry that builds an agent
 * funnels through this. `roles` (default all five) are the roles this caller needs a wallet for; if any
 * is unmapped, the error names which.
 */
export function requireCircleFleet(
  env: Record<string, string | undefined> = process.env,
  roles: readonly AgentRole[] = FLEET_ROLES,
): CircleFleetConfig {
  const circle = circleFleetConfig(env);
  if (!circle) {
    throw new Error(
      "Circle is required for the agent fleet (no HD/raw-key fallback). Set CIRCLE_API_KEY, " +
        "CIRCLE_ENTITY_SECRET, and a wallet id per role (CIRCLE_WALLET_ID_LONG/_SHORT/_MM/_FUNDING/_DARK, " +
        "or CIRCLE_AGENT_WALLET_IDS=id1,id2,id3,id4,id5). Create a set + 5 wallets: " +
        "cd packages/sdk && bun run circle:wallets --name sidekick-agents --count 5",
    );
  }
  const missing = roles.filter((r) => !circle.walletIdFor(r));
  if (missing.length) {
    throw new Error(
      `Circle wallet id missing for role(s): ${missing.join(", ")}. Set ` +
        `${missing.map((r) => `CIRCLE_WALLET_ID_${r.toUpperCase()}`).join(" / ")} ` +
        "(or include them in CIRCLE_AGENT_WALLET_IDS, in long,short,mm,funding,dark order).",
    );
  }
  return circle;
}

/**
 * Build a Circle-backed `SideKick` client for a role — the single seam every fleet entry (the agent
 * runners, fund/close-all/register-identities scripts) uses. Signs + broadcasts through the role's Circle MPC
 * wallet (no raw key in-process). Throws (via {@link requireCircleFleet}) if Circle isn't configured
 * for this role. Async because the Circle signer resolves the wallet address via Circle's API.
 */
export async function circleSkForRole(
  role: AgentRole,
  env: Record<string, string | undefined> = process.env,
): Promise<SideKick> {
  const circle = requireCircleFleet(env, [role]);
  const walletId = circle.walletIdFor(role) as string; // requireCircleFleet guaranteed it
  const { account, broadcaster } = await circleSigner({
    apiKey: circle.apiKey,
    entitySecret: circle.entitySecret,
    walletId,
  });
  return new SideKick({ network: "arc-testnet", account, broadcaster, engineUrl: engineUrl(env) });
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
