/**
 * The scripted demo scenario (Doc 3 §11) — the per-agent policy parameters and staging timings that
 * produce a clean, legible demo. Centralized here so a role's sizing/leverage is identical whether it
 * runs standalone (`bun run agent:long`) or under the orchestrator, and so the whole demo is
 * reproducible (seeded keys + fixed params = the same run every time, the Doc 3 §11 backup property).
 *
 * The sequence (mapping to Doc 3 §11 steps):
 *   1. long + short open early → the per-block loop is alive, the book has two sides.
 *   2. funding-strategy (hero) opens → rides the funding-receiving side, re-centering each block.
 *   3. the long pushes skew (bigger/levered) so convex funding + the OI cap become visible.
 *   4. the MM arrives mid-run → takes the balancing side, skew self-corrects.
 *   5. the dark agent goes silent → smooth decrement, no liquidation.
 *
 * Timings are in *agent blocks* (each runner's local counter), not Arc blocks. Sizes are small (this
 * is testnet USDC) but distinct enough to read on the dashboard. Tune freely — they're just knobs.
 */

import type { AgentRole } from "@sidekick/sdk";
import { darkPolicy, directionalPolicy, fundingStrategyPolicy, mmPolicy } from "./policies.ts";
import type { AgentPolicy } from "./policy.ts";

/** Per-role demo parameters (collateral in decimal USDC, leverage as sugar, stage = open/arrive block). */
export interface RoleParams {
  collateral: string;
  leverage: number;
  /** The agent's local block to open/arrive at (staggers the scenario). */
  stage: number;
  /** Trading collateral to onboard into the Vault (decimal USDC) — sized to cover margin + calls. */
  vaultUSDC: string;
  /** Gateway unified balance to onboard (decimal USDC) — funds the x402 margin-call nanopayments. */
  gatewayUSDC: string;
}

/**
 * The demo scenario parameters per role. Kept conservative for testnet:
 *   - long is the bigger, levered "skew pusher" so funding + the cap are visible.
 *   - short balances it lightly so the book starts two-sided.
 *   - funding (hero) is mid-size and flips to the receiving side every block.
 *   - mm arrives at block 8 to pull skew back.
 *   - dark is thin + high-leverage so its decrement is fast and legible; it is silent from the moment
 *     it opens (`DARK_GOES_SILENT_AFTER = 0`), so it funds NO Gateway balance and never attempts a
 *     payment it cannot make — it just opens and decrements (the no-liquidation proof, Doc 3 §11 step 3).
 */
export const SCENARIO: Record<AgentRole, RoleParams> = {
  long: { collateral: "4", leverage: 4, stage: 1, vaultUSDC: "8", gatewayUSDC: "2" },
  short: { collateral: "2", leverage: 2, stage: 1, vaultUSDC: "5", gatewayUSDC: "2" },
  funding: { collateral: "3", leverage: 3, stage: 3, vaultUSDC: "7", gatewayUSDC: "2" },
  mm: { collateral: "3", leverage: 3, stage: 8, vaultUSDC: "7", gatewayUSDC: "2" },
  dark: { collateral: "1", leverage: 20, stage: 2, vaultUSDC: "2", gatewayUSDC: "0" },
};

/**
 * The dark agent goes silent this many blocks after it opens. 0 = silent immediately on open, so it
 * never attempts an x402 payment (it funds no Gateway balance) and goes straight to decrementing —
 * the cleanest form of the anti-liquidation proof.
 */
export const DARK_GOES_SILENT_AFTER = 0;

/** Build the policy for a role from the scenario params. */
export function policyForRole(role: AgentRole): AgentPolicy {
  const p = SCENARIO[role];
  switch (role) {
    case "long":
      return directionalPolicy({
        id: "long",
        side: "long",
        collateral: p.collateral,
        leverage: p.leverage,
        openAt: p.stage,
      });
    case "short":
      return directionalPolicy({
        id: "short",
        side: "short",
        collateral: p.collateral,
        leverage: p.leverage,
        openAt: p.stage,
      });
    case "funding":
      return fundingStrategyPolicy({
        id: "funding",
        collateral: p.collateral,
        leverage: p.leverage,
        openAt: p.stage,
      });
    case "mm":
      return mmPolicy({
        id: "mm",
        collateral: p.collateral,
        leverage: p.leverage,
        arriveAt: p.stage,
      });
    case "dark":
      return darkPolicy({
        id: "dark",
        collateral: p.collateral,
        leverage: p.leverage,
        openAt: p.stage,
        goesDarkAt: p.stage + DARK_GOES_SILENT_AFTER,
      });
  }
}
