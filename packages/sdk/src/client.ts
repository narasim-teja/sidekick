/**
 * `SideKick` — the agent-facing client (Doc 2 §5.1). One object an agent (or a human's script, or an
 * MCP wrapper) constructs to **read** venue state, **act** (open/close, post/withdraw collateral,
 * provide liquidity), **subscribe** to the per-block stream, **onboard** (Gateway + Vault + optional
 * ERC-8004), and **answer margin calls** as gas-free Gateway nanopayments.
 *
 * Design intent:
 *   - The SDK is a thin, ergonomic wrapper over surfaces that already exist (the deployed contracts +
 *     the live engine), NOT new infrastructure. Reads → the engine's REST/WS; acts → direct viem
 *     writes to the permissionless contract functions; answer-call → the x402 `/pay` buyer flow.
 *   - It signs with either a raw `privateKey` or a viem `Account`, so it is KMS/hardware-wallet ready,
 *     not demo-only.
 *   - Money/price units cross the boundary as human decimal strings; the SDK converts to the venue's
 *     6dp/WAD integers at the edge using the engine's canonical port (no drift vs on-chain).
 *
 * It deliberately does NOT expose operator-only calls (`checkpoint`, `answerMarginCall`-as-operator):
 * those belong to the engine. An account answers a call by *paying* (x402) or by keeping free
 * collateral for the contract's in-checkpoint auto-settle — never by calling the operator path.
 *
 * @see packages/engine/src/state.ts (the WS/REST payload) · src/payments/routes.ts (the x402 seller)
 */

import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  ARC,
  ARC_TESTNET_DEPLOYMENT,
  arcTestnet,
  type MarketSymbol,
  marketDeployment,
  marketId as marketIdOf,
  rpcUrl as sharedRpcUrl,
} from "@sidekick/shared";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACCOUNT_MANAGER_ABI,
  erc20Abi,
  ORACLE_ADAPTER_ABI,
  PERP_ENGINE_ABI,
  POOL_ABI,
  VAULT_ABI,
} from "./abis.ts";
import { BlockStream } from "./stream.ts";
import type {
  AccountView,
  MarketBlockState,
  OnboardOptions,
  OnboardResult,
  OpenOptions,
  SideKickConfig,
} from "./types.ts";
import { formatUsdc, formatWad, notionalFromLeverage, parseMarkWad, parseUsdc } from "./units.ts";

const SIDES = ["flat", "long", "short"] as const;

/** The Gateway chain alias for Arc testnet (the `@circle-fin/x402-batching` SDK's first-class name). */
const GATEWAY_CHAIN = "arcTestnet" as const;

/** A block-stream subscriber callback. */
export type BlockHandler = (state: MarketBlockState) => void;

export class SideKick {
  /** The signing account (EOA). */
  readonly account: Account;
  /** This account's address. */
  readonly address: Address;
  /** The engine REST base URL. */
  readonly engineUrl: string;

  private readonly chain: Chain;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient<Transport, Chain, Account>;
  private readonly wsUrl: string;
  private readonly privateKey?: Hex;
  private stream?: BlockStream;
  private gatewayInstance?: GatewayClient;

  constructor(config: SideKickConfig) {
    if (config.network && config.network !== "arc-testnet") {
      throw new Error(`Only "arc-testnet" is live; got "${config.network}"`);
    }
    this.account = config.account ?? privateKeyToAccount(config.privateKey as Hex);
    this.privateKey = config.privateKey;
    this.address = this.account.address;
    this.engineUrl = (config.engineUrl ?? "http://localhost:8787").replace(/\/$/, "");
    this.wsUrl = config.wsUrl ?? `${this.engineUrl.replace(/^http/, "ws")}/ws`;

    const rpc = config.rpcUrl ?? sharedRpcUrl();
    this.chain = arcTestnet();
    this.pub = createPublicClient({ chain: this.chain, transport: http(rpc) }) as PublicClient;
    this.wallet = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(rpc),
    });
  }

  // ── Identifiers ───────────────────────────────────────────────────────────────

  /** The deployed venue addresses (Vault, PerpEngine, per-market pools, etc.). */
  get deployment() {
    return ARC_TESTNET_DEPLOYMENT;
  }

  private marketId(symbol: MarketSymbol): Hex {
    return marketIdOf(symbol) as Hex;
  }

  // ── Read: engine state (REST + WS) ──────────────────────────────────────────────

  /**
   * Fetch the latest per-block state for one market from the engine (REST). Returns `null` if the
   * engine has not produced a state for that market yet (HTTP 404 — e.g. polling before the first
   * checkpoint), so a consumer started ahead of the engine waits rather than crashing. Other HTTP
   * errors still throw.
   */
  async getState(market: MarketSymbol): Promise<MarketBlockState | null> {
    const res = await fetch(`${this.engineUrl}/state/${market}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`engine /state/${market} → ${res.status}`);
    return (await res.json()) as MarketBlockState;
  }

  /** Fetch the latest state for every market the engine is running. */
  async getAllState(): Promise<MarketBlockState[]> {
    const res = await fetch(`${this.engineUrl}/state`);
    if (!res.ok) throw new Error(`engine /state → ${res.status}`);
    return (await res.json()) as MarketBlockState[];
  }

  /** Fetch the engine's overall status (markets, cadence, totals). */
  async getStatus(): Promise<import("./types.ts").EngineStatus> {
    const res = await fetch(`${this.engineUrl}/status`);
    if (!res.ok) throw new Error(`engine /status → ${res.status}`);
    return (await res.json()) as import("./types.ts").EngineStatus;
  }

  /**
   * Subscribe to the per-block state stream — the event loop an agent hangs off of (Doc 2 §5.1
   * "Subscribe"). Returns an unsubscribe function. The underlying WS auto-reconnects; the first
   * `block` frame arrives on the next engine tick. Multiple handlers share one socket.
   */
  on(event: "block", handler: BlockHandler): () => void {
    if (event !== "block") throw new Error(`unknown event "${event}"`);
    if (!this.stream) this.stream = new BlockStream(this.wsUrl);
    return this.stream.on(handler);
  }

  /** Disconnect the per-block WS stream (if open). Call on shutdown. (Distinct from {@link close}, which closes a position.) */
  disconnect(): void {
    this.stream?.close();
    this.stream = undefined;
  }

  // ── Read: own on-chain account ──────────────────────────────────────────────────

  /**
   * Read the live mark for a market (WAD 18dp). Prefers the on-chain oracle adapter; if that feed is
   * not pushed on-chain (Stork `NotFound` — true for ETH/SOL/HYPE/LINK on testnet) it falls back to
   * the engine's current state mark (the synthetic mark the engine is injecting into `checkpoint`).
   * So the SDK works for synthetic-mark markets too, and an open/close prices at the same mark the
   * engine's checkpoint uses.
   */
  async getMarkWad(market: MarketSymbol): Promise<bigint> {
    const adapter = marketDeployment(this.deployment, market).oracleAdapter;
    try {
      const mark = (await this.pub.readContract({
        address: adapter,
        abi: ORACLE_ADAPTER_ABI,
        functionName: "getMark",
      })) as { price18: bigint; timestampMs: bigint };
      if (mark.price18 > 0n) return mark.price18;
    } catch {
      /* feed not pushed on-chain — fall back to the engine's state mark below */
    }
    const state = await this.getState(market);
    if (state) return parseMarkWad(state.mark);
    throw new Error(
      `no mark available for ${market} (on-chain feed unpushed and no engine state yet)`,
    );
  }

  /** This account's un-utilized collateral in the Vault (USDC 6dp). */
  async freeCollateral(): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.deployment.vault,
      abi: VAULT_ABI,
      functionName: "freeCollateral",
      args: [this.address],
    })) as bigint;
  }

  /**
   * This account's joined view in a market: position + equity (at the live mark) + free collateral,
   * formatted as decimal strings. The agent's own read for decisions.
   */
  async getAccount(market: MarketSymbol): Promise<AccountView> {
    const mark = await this.getMarkWad(market);
    const [pos, equity, free] = await Promise.all([
      this.pub.readContract({
        address: this.deployment.perpEngine,
        abi: PERP_ENGINE_ABI,
        functionName: "positionOf",
        args: [this.marketId(market), this.address],
      }) as Promise<{ side: number; entryNotional: bigint; entryMark: bigint; margin: bigint }>,
      this.pub.readContract({
        address: this.deployment.perpEngine,
        abi: PERP_ENGINE_ABI,
        functionName: "equityOf",
        args: [this.marketId(market), this.address, mark],
      }) as Promise<bigint>,
      this.freeCollateral(),
    ]);
    return {
      address: this.address,
      market,
      side: SIDES[pos.side] ?? "flat",
      entryNotional: formatUsdc(pos.entryNotional),
      entryMark: formatWad(pos.entryMark),
      margin: formatUsdc(pos.margin),
      equity: formatUsdc(equity),
      freeCollateral: formatUsdc(free),
    };
  }

  // ── Act: collateral ─────────────────────────────────────────────────────────────

  /**
   * Deposit USDC into the Vault as trading collateral (free collateral). Approves the Vault for the
   * ERC-20 transfer first if needed. `amount` is a decimal USDC string. Returns the deposit tx hash.
   */
  async deposit(amount: string): Promise<Hex> {
    const value = parseUsdc(amount);
    const usdc = this.deployment.usdc;
    const vault = this.deployment.vault;
    const allowance = (await this.pub.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.address, vault],
    })) as bigint;
    if (allowance < value) {
      const approveTx = await this.wallet.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [vault, value],
        chain: this.chain,
        account: this.account,
      });
      await this.pub.waitForTransactionReceipt({ hash: approveTx });
    }
    return this.write(vault, VAULT_ABI, "deposit", [value]);
  }

  /** Withdraw un-utilized collateral from the Vault back to the wallet. Decimal USDC string. */
  async withdraw(amount: string): Promise<Hex> {
    return this.write(this.deployment.vault, VAULT_ABI, "withdraw", [parseUsdc(amount)]);
  }

  // ── Act: positions ──────────────────────────────────────────────────────────────

  /**
   * Open a position. The venue takes `{side, notional, margin, mark}` — `margin` is `collateral`,
   * `notional` is either explicit or `collateral × leverage` (client-side sugar, Doc 3 §8). If `mark`
   * is omitted the SDK reads the live on-chain mark. Requires enough free collateral (call
   * {@link deposit} first). One position per market (POC) — {@link close} an existing one to flip.
   */
  async open(opts: OpenOptions): Promise<Hex> {
    if (opts.leverage !== undefined && opts.notional !== undefined) {
      throw new Error("pass either `leverage` or `notional`, not both");
    }
    const margin = parseUsdc(opts.collateral);
    const notional =
      opts.notional !== undefined
        ? parseUsdc(opts.notional)
        : notionalFromLeverage(opts.collateral, opts.leverage ?? 1);
    const mark =
      opts.mark !== undefined ? parseMarkWad(opts.mark) : await this.getMarkWad(opts.market);
    const sideEnum = opts.side === "long" ? 1 : 2;
    return this.write(this.deployment.perpEngine, PERP_ENGINE_ABI, "openPosition", [
      this.marketId(opts.market),
      sideEnum,
      notional,
      margin,
      mark,
    ]);
  }

  /** Close this account's position in a market at the live (or supplied) mark. */
  async close(market: MarketSymbol, mark?: string): Promise<Hex> {
    const markWad = mark !== undefined ? parseMarkWad(mark) : await this.getMarkWad(market);
    return this.write(this.deployment.perpEngine, PERP_ENGINE_ABI, "closePosition", [
      this.marketId(market),
      markWad,
    ]);
  }

  // ── Act: liquidity (LP / MM seeding) ────────────────────────────────────────────

  /** Provide liquidity to a market's pool from free collateral; mints slpUSDC shares. Decimal USDC. */
  async provideLiquidity(market: MarketSymbol, amount: string): Promise<Hex> {
    const pool = marketDeployment(this.deployment, market).pool;
    return this.write(pool, POOL_ABI, "provideLiquidity", [parseUsdc(amount)]);
  }

  /** Withdraw liquidity (burn slpUSDC shares) at the live (or supplied) mark. `shares` is 6dp decimal. */
  async withdrawLiquidity(market: MarketSymbol, shares: string, mark?: string): Promise<Hex> {
    const pool = marketDeployment(this.deployment, market).pool;
    const markWad = mark !== undefined ? parseMarkWad(mark) : await this.getMarkWad(market);
    return this.write(pool, POOL_ABI, "withdrawLiquidity", [parseUsdc(shares), markWad]);
  }

  // ── Act: answer a margin call (the x402 Gateway nanopayment) ─────────────────────

  /**
   * Answer this account's open margin call in a market as a **gas-free Gateway nanopayment** — the
   * headline Layer B flow (Doc 1 §5). It runs the x402 buyer handshake against the engine's
   * `/pay/:market/:account` seller resource: `GatewayClient.pay()` reads the 402 price (the account's
   * current shortfall), signs an EIP-3009 authorization against its Gateway unified balance, and
   * retries — the engine verifies + settles it off-chain (Circle's TEE facilitator) and lands it
   * on-chain via `answerMarginCall` next tick. Requires a funded Gateway unified balance
   * ({@link onboard} with `gatewayUSDC`, or `gateway().deposit(...)`).
   *
   * Returns the settlement result. `settled: false` with `reason: "no-open-margin-call"` means the
   * position was already healthy (nothing owed) — not an error.
   */
  async answerMarginCall(market: MarketSymbol): Promise<{
    settled: boolean;
    amount?: string;
    transaction?: string;
    reason?: string;
  }> {
    const url = `${this.engineUrl}/pay/${market}/${this.address}`;
    const { data } = await this.gatewayClient().pay<{
      settled?: boolean;
      reason?: string;
      amount?: string;
      transaction?: string;
    }>(url, { method: "POST" });
    return {
      settled: Boolean(data?.settled),
      amount: data?.amount,
      transaction: data?.transaction,
      reason: data?.reason,
    };
  }

  /** The current owed margin-call shortfall for this account in a market (USDC 6dp), per the engine. */
  async owed(market: MarketSymbol): Promise<bigint> {
    const res = await fetch(`${this.engineUrl}/owed/${market}/${this.address}`);
    if (!res.ok) return 0n;
    const body = (await res.json()) as { owed?: string };
    return BigInt(body.owed ?? "0");
  }

  // ── Onboard: one flow (Gateway + Vault + optional identity) ─────────────────────

  /**
   * Onboard the account in one pass (Doc 2 §5.1 "Onboard"): fund the Gateway unified balance (the
   * off-chain balance nanopayments draw against), post Vault trading collateral, and optionally link
   * an ERC-8004 identity. Each step is skipped if its option is absent. Idempotent-ish: depositing
   * twice just adds more.
   */
  async onboard(opts: OnboardOptions = {}): Promise<OnboardResult> {
    const out: OnboardResult = { address: this.address };
    if (opts.gatewayUSDC) {
      const dep = await this.gatewayClient().deposit(opts.gatewayUSDC);
      out.gatewayDepositTx = dep.depositTxHash;
    }
    if (opts.depositUSDC) {
      out.vaultDepositTx = await this.deposit(opts.depositUSDC);
      await this.pub.waitForTransactionReceipt({ hash: out.vaultDepositTx });
    }
    if (opts.identityId !== undefined) {
      out.identityTx = await this.write(
        this.deployment.accountManager,
        ACCOUNT_MANAGER_ABI,
        "linkIdentity",
        [opts.identityId],
      );
    }
    return out;
  }

  /**
   * The underlying Circle `GatewayClient` (buyer side) for this account — read balances, deposit, or
   * pay directly. Lazily constructed; requires a `privateKey` (the Gateway SDK takes a raw key, so
   * accounts constructed from an external signer cannot use the Gateway path — pass `privateKey` if
   * you need nanopayments).
   */
  gateway(): GatewayClient {
    return this.gatewayClient();
  }

  /** This account's Gateway unified balance (available USDC 6dp + formatted). */
  async gatewayBalance(): Promise<{ available: bigint; formatted: string }> {
    const b = await this.gatewayClient().getBalances();
    return { available: b.gateway.available, formatted: b.gateway.formattedAvailable };
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  private gatewayClient(): GatewayClient {
    if (this.gatewayInstance === undefined) {
      if (!this.privateKey) {
        throw new Error(
          "Gateway nanopayments require a `privateKey` (the @circle-fin/x402-batching SDK signs with a raw key). " +
            "Construct SideKick with `privateKey` to use answerMarginCall / Gateway deposit.",
        );
      }
      this.gatewayInstance = new GatewayClient({
        chain: GATEWAY_CHAIN,
        privateKey: this.privateKey,
      });
    }
    return this.gatewayInstance;
  }

  /** Send a contract write and return its hash (no wait — callers wait if they need confirmation). */
  // biome-ignore lint/suspicious/noExplicitAny: viem ABI generics over a union of our hand-written ABIs.
  private async write(address: Address, abi: any, functionName: string, args: any[]): Promise<Hex> {
    return this.wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      chain: this.chain,
      account: this.account,
    });
  }

  /** Wait for a tx to land; returns whether it succeeded. */
  async confirm(hash: Hex): Promise<boolean> {
    const r = await this.pub.waitForTransactionReceipt({ hash });
    return r.status === "success";
  }

  /** The configured Arc chain id (5042002). */
  get chainId(): number {
    return ARC.chainId;
  }
}
