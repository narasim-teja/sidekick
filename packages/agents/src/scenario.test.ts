/**
 * Tests for the scripted scenario (scenario.ts) — the staging that makes the demo legible + the
 * role→policy wiring. We assert each role builds the expected archetype and that the dark agent's
 * silence is staged after its open (so it actually opens before going quiet).
 */

import { describe, expect, test } from "bun:test";
import { AGENT_ROLES } from "@sidekick/sdk";
import { isDarkPolicy } from "./policies.ts";
import { DARK_GOES_SILENT_AFTER, policyForRole, SCENARIO } from "./scenario.ts";

describe("SCENARIO", () => {
  test("defines params for all five roles", () => {
    for (const role of AGENT_ROLES) {
      expect(SCENARIO[role]).toBeDefined();
      expect(Number(SCENARIO[role].collateral)).toBeGreaterThan(0);
      expect(SCENARIO[role].leverage).toBeGreaterThan(0);
    }
  });

  test("each role's vault funding covers at least its margin", () => {
    for (const role of AGENT_ROLES) {
      const p = SCENARIO[role];
      expect(Number(p.vaultUSDC)).toBeGreaterThanOrEqual(Number(p.collateral));
    }
  });
});

describe("policyForRole", () => {
  test("maps each role to its archetype kind", () => {
    expect(policyForRole("long").kind).toBe("long");
    expect(policyForRole("short").kind).toBe("short");
    expect(policyForRole("mm").kind).toBe("mm");
    expect(policyForRole("funding").kind).toBe("funding-strategy");
    expect(policyForRole("dark").kind).toBe("dark");
  });

  test("only the dark agent declines to answer margin calls", () => {
    expect(policyForRole("long").answersMarginCalls).toBe(true);
    expect(policyForRole("funding").answersMarginCalls).toBe(true);
    expect(policyForRole("dark").answersMarginCalls).toBe(false);
  });

  test("the dark agent goes silent strictly after it opens", () => {
    const p = policyForRole("dark");
    expect(isDarkPolicy(p)).toBe(true);
    if (isDarkPolicy(p)) {
      const stage = SCENARIO.dark.stage;
      // Silent FROM its open block (DARK_GOES_SILENT_AFTER = 0) — it funds no Gateway balance and
      // never attempts a payment; it just opens and decrements.
      expect(p.isDark(stage - 1)).toBe(false); // before it opens, not yet dark
      expect(p.isDark(stage + DARK_GOES_SILENT_AFTER)).toBe(true); // dark from the open block on
    }
  });

  test("the dark agent funds no Gateway balance (it never answers, so it needs none)", () => {
    expect(SCENARIO.dark.gatewayUSDC).toBe("0");
  });
});
