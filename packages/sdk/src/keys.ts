/**
 * Deterministic agent identities from one seed (Doc 2 Phase 4 — "decide whether demo agents
 * pre-onboard via a script or self-onboard"; this is the key-management half of that).
 *
 * The venue's accounts are plain EOAs — a trader, an LP, an MM-agent, an oracle-agent are all the
 * same unified account, distinguished only by what they hold (Doc 1 §3.2). So spinning up 10 or 30
 * autonomous agents is just deriving 10 or 30 EOAs. We derive them all from ONE BIP-39 mnemonic via
 * the standard Ethereum HD path, so:
 *
 *   - a single `AGENTS_MNEMONIC` (or a generated seed) yields every agent key reproducibly,
 *   - one funding pass tops up all of them (the deriver enumerates them in order),
 *   - the demo is seeded/reproducible — agent N always has the same address.
 *
 * Path: `m/44'/60'/0'/0/<index>` (the BIP-44 Ethereum convention viem's `mnemonicToAccount` uses by
 * default via `addressIndex`). Index 0 is conventionally the operator/funder; named agents start at 1.
 *
 * This module is pure (no chain I/O), so it is safe to import anywhere and trivially testable.
 *
 * @see https://viem.sh/docs/accounts/local/mnemonicToAccount
 */

import { toHex } from "viem";
import type { HDAccount } from "viem/accounts";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";

/** The canonical role each demo agent plays (Doc 2 §4.1). Drives the scripted scenario + labels. */
export type AgentRole = "long" | "short" | "mm" | "funding" | "dark";

/** The five demo roles in scenario order (the order the orchestrator stages them). */
export const AGENT_ROLES: readonly AgentRole[] = [
  "long",
  "short",
  "mm",
  "funding",
  "dark",
] as const;

/** A derived agent identity: its HD index, role label, viem account, address, and raw private key. */
export interface AgentIdentity {
  /** HD address index (`m/44'/60'/0'/0/<index>`). */
  index: number;
  /** Human label (the role for named agents, or `agent-<index>` for anonymous fleet members). */
  label: string;
  /** The local viem account (signs txns + EIP-712). */
  account: HDAccount;
  /** Checksummed EOA address. */
  address: `0x${string}`;
  /**
   * The raw private key (0x-hex). Exposed because the Circle `@circle-fin/x402-batching` Gateway SDK
   * takes a raw key (not a viem signer), and `SideKick`'s nanopayment path needs it. Handle as a
   * secret — it is derived, not stored, but it IS the spending key for this agent's funds.
   */
  privateKey: `0x${string}`;
}

/**
 * Derive a single agent account from a mnemonic at the given HD index.
 * Index 0 is the operator/funder by convention; named demo agents use 1..N.
 */
export function deriveAgent(mnemonic: string, index: number, label?: string): AgentIdentity {
  const account = mnemonicToAccount(mnemonic, { addressIndex: index });
  const hd = account.getHdKey();
  if (!hd.privateKey) throw new Error(`HD derivation produced no private key at index ${index}`);
  return {
    index,
    label: label ?? `agent-${index}`,
    account,
    address: account.address,
    privateKey: toHex(hd.privateKey),
  };
}

/**
 * Derive the five named demo agents (long, short, mm, funding, dark) at indices 1..5, in the
 * canonical {@link AGENT_ROLES} order. The orchestrator and per-agent runners share this so a role
 * always maps to the same address across runs.
 */
export function deriveDemoAgents(mnemonic: string): Record<AgentRole, AgentIdentity> {
  const out = {} as Record<AgentRole, AgentIdentity>;
  AGENT_ROLES.forEach((role, i) => {
    out[role] = deriveAgent(mnemonic, i + 1, role);
  });
  return out;
}

/**
 * Derive a fleet of `count` anonymous agents at indices `start..start+count-1`. For scale tests
 * (10–30 agents) where roles don't matter — just N independent accounts off the one seed.
 */
export function deriveFleet(mnemonic: string, count: number, start = 1): AgentIdentity[] {
  return Array.from({ length: count }, (_, i) => deriveAgent(mnemonic, start + i));
}

/**
 * The operator/funder account (HD index 0) — the address that holds the faucet USDC and tops up the
 * derived agents. (Distinct from the venue's checkpoint operator `PRIVATE_KEY`, which may be a
 * different key; this is just "agent index 0".)
 */
export function deriveFunder(mnemonic: string): AgentIdentity {
  return deriveAgent(mnemonic, 0, "funder");
}

/**
 * Generate a fresh BIP-39 mnemonic (for first-time setup — print it, save to `.env` as
 * `AGENTS_MNEMONIC`, fund index 0). Uses viem's bundled English wordlist.
 */
export function generateAgentsMnemonic(): string {
  return generateMnemonic(english);
}

/** Validate that a string looks like a 12/24-word BIP-39 mnemonic (cheap shape check, not checksum). */
export function isLikelyMnemonic(s: string): boolean {
  const words = s.trim().split(/\s+/);
  return words.length === 12 || words.length === 24;
}
