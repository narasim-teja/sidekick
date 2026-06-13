/**
 * Tests for the HD key derivation (keys.ts) — the identity layer that scales to 10–30 agents off one
 * seed. We assert: determinism (a seed always yields the same addresses), uniqueness (no two agents
 * collide), the role→index mapping is stable, the derived private key matches its address, and the
 * fleet derivation is contiguous + distinct. These guard the "spin up 30 agents" property.
 */

import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGENT_ROLES,
  deriveAgent,
  deriveDemoAgents,
  deriveFleet,
  deriveFunder,
  generateAgentsMnemonic,
  isLikelyMnemonic,
} from "./keys.ts";

// A fixed seed for reproducible assertions (the canonical hardhat dev mnemonic — public, holds nothing).
const SEED = "test test test test test test test test test test test junk";

describe("deriveAgent", () => {
  test("is deterministic for a given seed + index", () => {
    const a = deriveAgent(SEED, 1);
    const b = deriveAgent(SEED, 1);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  test("derives the canonical hardhat addresses (standard m/44'/60'/0'/0/<i> path)", () => {
    // hardhat account #0 / #1 — proves we use the standard Ethereum HD path.
    expect(deriveAgent(SEED, 0).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(deriveAgent(SEED, 1).address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  test("the derived private key recovers the same address", () => {
    const a = deriveAgent(SEED, 3);
    expect(privateKeyToAccount(a.privateKey).address).toBe(a.address);
  });

  test("different indices give different accounts", () => {
    expect(deriveAgent(SEED, 1).address).not.toBe(deriveAgent(SEED, 2).address);
  });
});

describe("deriveDemoAgents", () => {
  test("maps the five roles to indices 1..5 in order", () => {
    const agents = deriveDemoAgents(SEED);
    expect(Object.keys(agents).sort()).toEqual([...AGENT_ROLES].sort());
    AGENT_ROLES.forEach((role, i) => {
      expect(agents[role].index).toBe(i + 1);
      expect(agents[role].label).toBe(role);
    });
  });

  test("the five demo agents are all distinct addresses", () => {
    const agents = deriveDemoAgents(SEED);
    const addrs = AGENT_ROLES.map((r) => agents[r].address);
    expect(new Set(addrs).size).toBe(AGENT_ROLES.length);
  });

  test("role→address is stable across calls (reproducible demo)", () => {
    expect(deriveDemoAgents(SEED).funding.address).toBe(deriveDemoAgents(SEED).funding.address);
  });
});

describe("deriveFleet", () => {
  test("derives N contiguous, unique agents (scales to 30)", () => {
    const fleet = deriveFleet(SEED, 30);
    expect(fleet).toHaveLength(30);
    expect(new Set(fleet.map((f) => f.address)).size).toBe(30);
    expect(fleet[0]?.index).toBe(1);
    expect(fleet[29]?.index).toBe(30);
  });

  test("a fleet member at index i equals deriveAgent(seed, i)", () => {
    const fleet = deriveFleet(SEED, 5, 1);
    expect(fleet[2]?.address).toBe(deriveAgent(SEED, 3).address);
  });

  test("the funder is index 0 and distinct from named agents", () => {
    const funder = deriveFunder(SEED);
    expect(funder.index).toBe(0);
    const agents = deriveDemoAgents(SEED);
    for (const role of AGENT_ROLES) expect(agents[role].address).not.toBe(funder.address);
  });
});

describe("mnemonic helpers", () => {
  test("generateAgentsMnemonic produces a valid 12-word seed", () => {
    const m = generateAgentsMnemonic();
    expect(m.split(/\s+/)).toHaveLength(12);
    expect(isLikelyMnemonic(m)).toBe(true);
  });

  test("isLikelyMnemonic accepts 12/24 words, rejects others", () => {
    expect(isLikelyMnemonic(SEED)).toBe(true);
    expect(isLikelyMnemonic("only three words here".repeat(1))).toBe(false);
    expect(isLikelyMnemonic("0xdeadbeef")).toBe(false);
  });
});
