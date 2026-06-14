/**
 * On-chain deployment addresses for the SideKick venue contracts (Phase 2).
 *
 * This is the single source of truth the engine (Phase 3), SDK (Phase 5), and dashboard (Phase 7)
 * import to find the deployed contracts. The contracts are built + fully Foundry-tested in
 * `packages/contracts` and **deployed live to Arc Testnet** (`forge script script/Deploy.s.sol
 * --broadcast`) — the addresses below are the real, on-chain venue.
 *
 * The deploy script logs every address; they are copied here verbatim from the broadcast run.
 *
 * Live deploy: chain 5042002, blocks 46_895_808–46_895_950, 2026-06-13. Collateral is the
 * canonical Arc testnet USDC (`0x3600…0000`, 6dp — the faucet token, also the gas token: Spike C).
 * Owner is the deployer EOA (POC; a real deploy sets `OWNER_ADDRESS` to a multisig/timelock).
 *
 * @see packages/contracts/script/Deploy.s.sol (emits these)
 * @see packages/contracts/broadcast/Deploy.s.sol/5042002/run-latest.json (the broadcast record)
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 2 (deploy + write addresses to shared)
 */

import type { Address } from "viem";
import { ARC } from "./constants.ts";
import type { MarketSymbol } from "./markets.ts";

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
  /**
   * Block the venue was deployed at — the engine's event backfill starts here (scanning from
   * genesis is impractical, and nothing relevant happened before this block).
   */
  readonly deploymentBlock: bigint;
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
 * Arc Testnet deployment — **LIVE** (broadcast 2026-06-13, chain 5042002). Verified on-chain:
 * PerpEngine.registry/vault wired, Vault.usdc = canonical USDC with the engine as operator, all
 * five markets registered, and the BTC StorkAdapter reads a live mark ($70,627). The other four
 * markets' Stork feeds are not pushed on testnet (the adapter reverts `NotFound`); the engine's
 * oracle layer falls back to a deterministic mark for those (Phase 3, see `engine/src/oracle`).
 */
export const ARC_TESTNET_DEPLOYMENT: VenueDeployment = {
  chainId: ARC.chainId,
  isDeployed: true,
  deploymentBlock: 46_895_808n,
  usdc: "0x3600000000000000000000000000000000000000" as Address,
  vault: "0x4E78654a6DC9513a938477E69F0fe3F39A9AC0d0" as Address,
  marketRegistry: "0x324CB5E497D1817c3B693a13944F5c0BDC444D6d" as Address,
  perpEngine: "0x1ABeca7EA5963e0bf1a408658B27BAa274667E6c" as Address,
  accountManager: "0x1F9F7abC683342FC61AF003834edBC357f75EcbD" as Address,
  markets: {
    "BTC-PERP": {
      pool: "0xbB17DE89413cB1Cc472977c50676321286cd525F" as Address,
      lpToken: "0x6d1c565Ba2210C76805210B9EBE22FbbbAC22D7D" as Address,
      oracleAdapter: "0x7F4E622c79378588b4E99f3a75d1f5fAa62aedE1" as Address,
    },
    "ETH-PERP": {
      pool: "0x34163040c9e570e991C02219d1627c633b2f6642" as Address,
      lpToken: "0xfdA3D758478C6adB378f0409Db3aFC31500eA43D" as Address,
      oracleAdapter: "0xa7937d17FeCDC7c2266d0Fdeb4BD551E1B5aDe79" as Address,
    },
    "SOL-PERP": {
      pool: "0x57D23a7F93d71808164d58243072ed7149CBf99c" as Address,
      lpToken: "0x632bb2c57f38AAEb9340A999c291b39B6ab82026" as Address,
      oracleAdapter: "0x2C9A2F836B3f3BEB522a8908b1A7027d61C7144e" as Address,
    },
    "HYPE-PERP": {
      pool: "0x4fcf9EDFe1de0E6Ae151a3CABBbfdb7f30776474" as Address,
      lpToken: "0x171843ECcc03586AF7c2126119B5b839c32dECA6" as Address,
      oracleAdapter: "0x88be8A56e5FCa8d1597FB47F73Ed126AeCeDab5c" as Address,
    },
    "LINK-PERP": {
      pool: "0x81a445bf640e549E4b8aC00f19C76dB5de43A8E8" as Address,
      lpToken: "0xeD20A0fE33DB62Aac8313a806d594586bf31a68c" as Address,
      // Repointed to MarkReceiver — the Chainlink CRE consumer. The CRE workflow's DON→KeystoneForwarder
      // calls MarkReceiver.onReport on Arc (the qualifying on-chain Chainlink state change); the engine
      // then reads it via getMark (chainlink-live). Prior adapters: StorkAdapter
      // 0x1091b1718609c040EbB01571b90aE0d67417bB34, relay ChainlinkAdapter 0xac8d01e357aa87dca276bed1435b161cbda0ef10,
      // single-forwarder MarkReceiver 0x1f221318bb193473b3a4f8dcbaa9fc2a71c2b45f.
      oracleAdapter: "0xb9f26b08c50aefe367308d89f7a2dacf2aec5d37" as Address,
    },
  },
};

/** Convenience: the deployment for a given chain id (only Arc Testnet today). */
export function deploymentFor(chainId: number): VenueDeployment {
  if (chainId === ARC.chainId) return ARC_TESTNET_DEPLOYMENT;
  throw new Error(`No SideKick deployment for chain ${chainId}`);
}

/** Look up a market's on-chain addresses, throwing if the market is not deployed. */
export function marketDeployment(
  deployment: VenueDeployment,
  symbol: MarketSymbol,
): MarketDeployment {
  const m = deployment.markets[symbol];
  if (!m) throw new Error(`Market ${symbol} is not in the deployment`);
  return m;
}

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
