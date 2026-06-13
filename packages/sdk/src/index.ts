/**
 * @sidekick/sdk — agent-facing client for the SideKick venue.
 *
 * Phase 5 builds this out into the full read / act / subscribe / onboard surface
 * (Doc 2 §5.1). For now it re-exports the shared types so consumers have a stable import
 * site, and pins the intended public shape as a reference.
 *
 * Intended surface (Phase 5):
 *   const sk = new SideKick({ network: "arc-testnet" });
 *   await sk.onboard({ depositUSDC: "100" });   // fund Gateway unified balance (+ optional ERC-8004)
 *   sk.on("block", (s) => { ... });              // per-block state push
 *   await sk.open({ market: "ETH-PERP", side: "long", collateral: "20", leverage: 10 });
 */

export type { MarketConfig, MarketSymbol } from "@sidekick/shared";
export { MARKET_SYMBOLS, MARKETS } from "@sidekick/shared";

// Placeholder export so the package is importable before Phase 5 lands the client.
export const SDK_VERSION = "0.0.0" as const;
