/**
 * On-chain deployment addresses for the SideKick venue contracts (Phase 2).
 *
 * This is the single source of truth the engine (Phase 3), SDK (Phase 5), and dashboard (Phase 7)
 * import to find the deployed contracts. The contracts are built + fully Foundry-tested in
 * `packages/contracts`; the **addresses below are populated after the live Arc-testnet deploy**
 * (`forge script script/Deploy.s.sol --broadcast --verify`) — until then they are the zero address
 * and `isDeployed` is false.
 *
 * The deploy script logs every address; copy them here verbatim after a broadcast run.
 *
 * @see packages/contracts/script/Deploy.s.sol (emits these)
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 2 (deploy + write addresses to shared)
 */

import type { Address } from "viem";
import { ARC } from "./constants.ts";
import type { MarketSymbol } from "./markets.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Per-market contract addresses (each market is an isolated Pool + its slpUSDC LP token). */
export interface MarketDeployment {
  /** The isolated Pool contract (universal counterparty + gap fund). */
  readonly pool: Address;
  /** The branded LP share token (slpUSDC-<MKT>). */
  readonly lpToken: Address;
  /** The IOracleAdapter (StorkAdapter now; Chainlink behind the same interface). */
  readonly oracleAdapter: Address;
}

/** The full venue deployment on one network. */
export interface VenueDeployment {
  readonly chainId: number;
  /** True once the addresses below are real (post-broadcast). */
  readonly isDeployed: boolean;
  /** Collateral token — on Arc, the canonical testnet USDC (also the gas token). */
  readonly usdc: Address;
  readonly vault: Address;
  readonly marketRegistry: Address;
  readonly perpEngine: Address;
  readonly accountManager: Address;
  /** Per-market Pool + LP token + oracle adapter, keyed by market symbol. */
  readonly markets: Partial<Record<MarketSymbol, MarketDeployment>>;
}

/**
 * Arc Testnet deployment. **Placeholder** until the Phase-2 live deploy is broadcast — fill the
 * addresses from the deploy-script logs, set `usdc` to the canonical Arc testnet USDC, and flip
 * `isDeployed` to true.
 */
export const ARC_TESTNET_DEPLOYMENT: VenueDeployment = {
  chainId: ARC.chainId,
  isDeployed: false,
  usdc: ZERO,
  vault: ZERO,
  marketRegistry: ZERO,
  perpEngine: ZERO,
  accountManager: ZERO,
  markets: {},
};

/** Compute a market id (bytes32) from its symbol — the key the MarketRegistry uses. */
// The on-chain MarketRegistry keys markets by `bytes32(symbol)` (the raw UTF-8 bytes, right-padded),
// matching `bytes32("BTC-PERP")` in Deploy.s.sol. This helper produces the same value off-chain.
export function marketId(symbol: MarketSymbol): `0x${string}` {
  const bytes = new TextEncoder().encode(symbol);
  if (bytes.length > 32) throw new Error(`Market symbol too long for bytes32: ${symbol}`);
  const padded = new Uint8Array(32);
  padded.set(bytes); // right-padded with zeros, like Solidity's bytes32(stringLiteral)
  return `0x${Buffer.from(padded).toString("hex")}`;
}
