/**
 * Venue — a typed read/write wrapper over the deployed SideKick contracts on Arc. The engine reads
 * authoritative state through here (positions, free collateral, pool capital/exposure, params) and
 * writes the two authoritative transitions it owns as the trusted operator: `checkpoint` (the §4.3
 * loop) and `answerMarginCall` (landing a settled Gateway top-up on-chain).
 *
 * All amounts are the venue's integer units (USDC 6dp, WAD 18dp) — the same bigints the fixed-point
 * compute uses — so nothing is ever converted to float on the authoritative path.
 *
 * @see packages/shared/src/deployments.ts (addresses) · packages/contracts/src (the contracts)
 */

import {
  ARC,
  deploymentFor,
  type MarketSymbol,
  marketDeployment,
  marketId as marketIdOf,
  type VenueDeployment,
} from "@sidekick/shared";
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { PERP_ENGINE_ABI, POOL_ABI, VAULT_ABI } from "./abis.ts";

/** Position side as decoded from the on-chain enum (0 Flat, 1 Long, 2 Short). */
export type OnChainSide = "flat" | "long" | "short";

/** A position read from PerpEngine (USDC 6dp amounts; entryMark WAD 18dp). */
export interface OnChainPosition {
  side: OnChainSide;
  entryNotional: bigint;
  entryMark: bigint;
  margin: bigint;
}

/** A market's live pool snapshot (USDC 6dp; netQty WAD 18dp). */
export interface PoolSnapshot {
  capital: bigint;
  gapFund: bigint;
  netQtyWad: bigint;
  fundingAccrued: bigint;
  exposure: bigint;
  equity: bigint;
}

const SIDES: OnChainSide[] = ["flat", "long", "short"];

/** The venue bound to a network + clients, exposing the calls the engine needs. */
export class Venue {
  readonly deployment: VenueDeployment;

  constructor(
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    chainId: number = ARC.chainId,
  ) {
    this.deployment = deploymentFor(chainId);
    if (!this.deployment.isDeployed) throw new Error(`Venue not deployed on chain ${chainId}`);
  }

  /** bytes32 market id for a symbol (matches the on-chain registry key). */
  marketId(symbol: MarketSymbol): Hex {
    return marketIdOf(symbol) as Hex;
  }

  /** Addresses for one market (pool / lpToken / oracle adapter). */
  market(symbol: MarketSymbol) {
    return marketDeployment(this.deployment, symbol);
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────

  /** Read an account's position in a market. */
  async positionOf(symbol: MarketSymbol, account: Address): Promise<OnChainPosition> {
    const p = (await this.pub.readContract({
      address: this.deployment.perpEngine,
      abi: PERP_ENGINE_ABI,
      functionName: "positionOf",
      args: [this.marketId(symbol), account],
    })) as { side: number; entryNotional: bigint; entryMark: bigint; margin: bigint };
    return {
      side: SIDES[p.side] ?? "flat",
      entryNotional: p.entryNotional,
      entryMark: p.entryMark,
      margin: p.margin,
    };
  }

  /** Read an account's free (un-utilized) collateral in the Vault. */
  async freeCollateral(account: Address): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.deployment.vault,
      abi: VAULT_ABI,
      functionName: "freeCollateral",
      args: [account],
    })) as bigint;
  }

  /** Read the Vault's total custodied USDC (the conservation denominator). */
  async vaultTotalAssets(): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.deployment.vault,
      abi: VAULT_ABI,
      functionName: "totalAssets",
    })) as bigint;
  }

  /** Read the carried EMA state S_smooth for a market (WAD). */
  async smoothSkewPrev(symbol: MarketSymbol): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.deployment.perpEngine,
      abi: PERP_ENGINE_ABI,
      functionName: "smoothSkewPrev",
      args: [this.marketId(symbol)],
    })) as bigint;
  }

  /** Read the monotonic checkpoint counter for a market. */
  async checkpointCount(symbol: MarketSymbol): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.deployment.perpEngine,
      abi: PERP_ENGINE_ABI,
      functionName: "checkpointCount",
      args: [this.marketId(symbol)],
    })) as bigint;
  }

  /** Snapshot a market's pool at `mark` (capital, gap fund, exposure, equity). */
  async poolSnapshot(symbol: MarketSymbol, mark: bigint): Promise<PoolSnapshot> {
    const pool = this.market(symbol).pool;
    const [capital, gapFund, netQtyWad, fundingAccrued, exposure, equity] = (await Promise.all([
      this.pub.readContract({ address: pool, abi: POOL_ABI, functionName: "capital" }),
      this.pub.readContract({ address: pool, abi: POOL_ABI, functionName: "gapFund" }),
      this.pub.readContract({ address: pool, abi: POOL_ABI, functionName: "netQtyWad" }),
      this.pub.readContract({ address: pool, abi: POOL_ABI, functionName: "fundingAccrued" }),
      this.pub.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName: "exposure",
        args: [mark],
      }),
      this.pub.readContract({ address: pool, abi: POOL_ABI, functionName: "equity", args: [mark] }),
    ])) as [bigint, bigint, bigint, bigint, bigint, bigint];
    return { capital, gapFund, netQtyWad, fundingAccrued, exposure, equity };
  }

  // ── Writes (operator-gated authoritative transitions) ───────────────────────────

  /** Trigger the on-chain §4.3 checkpoint for a market at `mark` over `accounts`. */
  async checkpoint(symbol: MarketSymbol, mark: bigint, accounts: Address[]): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.deployment.perpEngine,
      abi: PERP_ENGINE_ABI,
      functionName: "checkpoint",
      args: [this.marketId(symbol), mark, accounts],
      chain: this.wallet.chain,
      account: this.wallet.account,
    });
  }

  /** Land a settled Gateway margin-call top-up on-chain (credits position margin from free collateral). */
  async answerMarginCall(symbol: MarketSymbol, account: Address, amount: bigint): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.deployment.perpEngine,
      abi: PERP_ENGINE_ABI,
      functionName: "answerMarginCall",
      args: [this.marketId(symbol), account, amount],
      chain: this.wallet.chain,
      account: this.wallet.account,
    });
  }

  /** Wait for a tx to land and return its receipt status. */
  async confirm(hash: Hex): Promise<boolean> {
    const r = await this.pub.waitForTransactionReceipt({ hash });
    return r.status === "success";
  }
}
