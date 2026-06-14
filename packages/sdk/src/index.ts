/**
 * @sidekick/sdk — the agent-facing client for the SideKick venue (Doc 2 Phase 5).
 *
 * The venue from a consumer's POV: read state, act, subscribe to the per-block stream, onboard, and
 * answer margin calls as gas-free Gateway nanopayments. A thin ergonomic wrapper over surfaces that
 * already exist (the deployed Arc contracts + the live engine) — not new infrastructure.
 *
 * Quickstart:
 *
 *     import { SideKick } from "@sidekick/sdk";
 *
 *     const sk = new SideKick({ network: "arc-testnet", privateKey });
 *     await sk.onboard({ depositUSDC: "100", gatewayUSDC: "20" });   // collateral + Gateway balance
 *     sk.on("block", (s) => { ...mark, skew, funding, my positions, settlement flow... });
 *     await sk.open({ market: "ETH-PERP", side: "long", collateral: "20", leverage: 10 });
 *     await sk.answerMarginCall("ETH-PERP");                          // x402 Gateway nanopayment
 *
 * Keys: import from "@sidekick/sdk/keys" to derive a fleet of agent EOAs from one seed.
 */

export const SDK_VERSION = "0.5.0" as const;

// Convenience re-exports from shared so consumers have one import site.
export {
  agentNamespacedId,
  ERC8004_MAINNET,
  ERC8004_TESTNET,
  type Erc8004Registries,
  erc8004For,
  getMarket,
  MARKET_SYMBOLS,
  MARKETS,
} from "@sidekick/shared";
// The client.
export { type BlockHandler, SideKick } from "./client.ts";
// Key derivation lives at the "@sidekick/sdk/keys" subpath; re-exported here for discoverability.
export {
  AGENT_ROLES,
  type AgentIdentity,
  type AgentRole,
  deriveAgent,
  deriveDemoAgents,
  deriveFleet,
  deriveFunder,
  generateAgentsMnemonic,
  isLikelyMnemonic,
} from "./keys.ts";
export { BlockStream } from "./stream.ts";
// Public types (re-exporting the engine's state payload + shared market vocabulary).
export type {
  AccountView,
  Broadcaster,
  EngineStatus,
  MarketBlockState,
  MarketConfig,
  MarketParams,
  MarketSymbol,
  OnboardOptions,
  OnboardResult,
  OpenOptions,
  PoolState,
  PositionState,
  SettlementEvent,
  Side,
  SideKickConfig,
  Signer,
  VenueDescriptor,
  VenueMarketDescriptor,
} from "./types.ts";
// Unit helpers (decimal-string ⇄ venue integers) for consumers that need them.
export { formatUsdc, formatWad, notionalFromLeverage, parseMarkWad, parseUsdc } from "./units.ts";
