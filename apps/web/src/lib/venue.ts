/**
 * Venue constants + identity mapping for the dashboard.
 *
 * The Arc facts mirror `@sidekick/shared` (`constants.ts`), duplicated to keep the browser bundle
 * free of the shared package's viem dependency. Source of truth is `packages/shared/src/constants.ts`.
 *
 * Agent identity: the demo agents are HD-derived EOAs (long/short/mm/funding/dark at indices 1-5 off
 * one seed; funder at index 0). The dashboard cannot derive keys (no mnemonic in the browser), and
 * does not need to, it only needs to LABEL an address. So at build/deploy time the five demo
 * addresses are provided via `NEXT_PUBLIC_AGENTS` (a JSON map of `address → role`), and the engine's
 * checkpoint operator is the pool/operator. Any unmapped address renders as a shortened hex with a
 * generated identicon hue. This keeps the dashboard a pure read-only client.
 */

/** Arc Testnet facts (mirror of `@sidekick/shared` ARC). */
export const ARC = {
  chainId: 5042002,
  name: "Arc Testnet",
  explorerUrl: "https://testnet.arcscan.app",
} as const;

/** A block explorer link for a tx hash (or address). */
export function arcscanTx(hash: string): string {
  return `${ARC.explorerUrl}/tx/${hash}`;
}
export function arcscanAddress(address: string): string {
  return `${ARC.explorerUrl}/address/${address}`;
}

/** The canonical demo agent roles, in scenario order (mirrors `@sidekick/sdk` AGENT_ROLES). */
export const AGENT_ROLES = ["long", "short", "mm", "funding", "dark"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Human-readable identity for an agent role: the strategy the agent runs (Doc 2 §4.1). */
export interface RoleProfile {
  role: AgentRole | "pool" | "operator" | "unknown";
  /** Short label shown in tables / nodes. */
  label: string;
  /** One-line strategy description (the "agent view" copy). */
  strategy: string;
  /** A CSS color token name (see globals.css) for this role's accent. */
  accent: string;
}

export const ROLE_PROFILES: Record<AgentRole | "pool" | "operator" | "unknown", RoleProfile> = {
  long: {
    role: "long",
    label: "LONG",
    strategy:
      "Directional long: opens levered, answers per-block margin calls, holds on the funding signal.",
    accent: "var(--accent-long)",
  },
  short: {
    role: "short",
    label: "SHORT",
    strategy: "Directional short: balances the book, answers calls from its funded balance.",
    accent: "var(--accent-short)",
  },
  mm: {
    role: "mm",
    label: "MARKET-MAKER",
    strategy:
      "Watches pool skew vs cap; takes the balancing side to earn funding carry, skew self-corrects on camera.",
    accent: "var(--accent-mm)",
  },
  funding: {
    role: "funding",
    label: "FUNDING-STRATEGY",
    strategy:
      "The hero: holds ~pure funding exposure that rides the funding-receiving side while shedding price risk.",
    accent: "var(--accent-funding)",
  },
  dark: {
    role: "dark",
    label: "DARK",
    strategy:
      "Goes silent on purpose: stops answering calls so the venue decrements it smoothly toward zero. No liquidation.",
    accent: "var(--accent-dark)",
  },
  pool: {
    role: "pool",
    label: "POOL",
    strategy:
      "The universal counterparty + decrement absorber. Capital is the stable headline; settlement flow is separate.",
    accent: "var(--accent-pool)",
  },
  operator: {
    role: "operator",
    label: "OPERATOR",
    strategy: "The engine that runs the per-block loop and lands the on-chain checkpoint.",
    accent: "var(--fg-dim)",
  },
  unknown: {
    role: "unknown",
    label: "AGENT",
    strategy: "An autonomous account trading the venue.",
    accent: "var(--fg-dim)",
  },
};

/**
 * The REPLAY fixture's agent addresses (the canned demo `replay.ts` plays when there is no live
 * engine). They are pinned literals so the dashboard labels roles out-of-the-box in replay mode with
 * NO env config. (Historically these were also the addresses the old HD demo fleet funded; the LIVE
 * fleet now signs through Circle MPC wallets whose addresses are not derived from a seed.)
 *
 * For a LIVE fleet, label each Circle wallet's address by role via `NEXT_PUBLIC_AGENTS` (a JSON
 * `{address: role}` map), which takes precedence over these replay-fixture defaults.
 */
export const DEMO_AGENT_ADDRESSES: Record<AgentRole, string> = {
  long: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  short: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
  mm: "0x6813eb9362372eef6200f3b1dbc3f819671cba69",
  funding: "0x1eff47bc3a10a45d4b230b5d10e37751fe6aa718",
  dark: "0xe1ab8145f7e55dc933d51a18c793f901a3a0b276",
};

const DEMO_AGENTS: Record<string, AgentRole> = Object.fromEntries(
  Object.entries(DEMO_AGENT_ADDRESSES).map(([role, addr]) => [addr, role as AgentRole]),
);

/**
 * Build the address→role map: the replay-fixture demo agents, overlaid with any `NEXT_PUBLIC_AGENTS`
 * env (a JSON object mapping lowercase address → role). The env wins for a live (Circle-wallet) fleet;
 * absent it, the replay-fixture addresses are still labelled. Unmapped addresses render as shortened hex.
 */
function parseAgentMap(): Map<string, AgentRole> {
  const map = new Map<string, AgentRole>();
  for (const [addr, role] of Object.entries(DEMO_AGENTS)) map.set(addr.toLowerCase(), role);
  const raw = process.env.NEXT_PUBLIC_AGENTS;
  if (raw) {
    try {
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const [addr, role] of Object.entries(obj)) {
        if ((AGENT_ROLES as readonly string[]).includes(role)) {
          map.set(addr.toLowerCase(), role as AgentRole);
        }
      }
    } catch {
      /* malformed, keep the built-in demo labels */
    }
  }
  return map;
}

const AGENT_MAP = parseAgentMap();

/** Resolve an address to its role profile (uses `NEXT_PUBLIC_AGENTS`, else "unknown"). */
export function profileFor(address: string): RoleProfile {
  const role = AGENT_MAP.get(address.toLowerCase());
  return role ? ROLE_PROFILES[role] : ROLE_PROFILES.unknown;
}

/** Shorten an address for display: 0x1234…cdef. */
export function shortAddress(address: string): string {
  if (!address.startsWith("0x") || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A stable hue [0,360) derived from an address, for identicon dots when no role is known. */
export function addressHue(address: string): number {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}
