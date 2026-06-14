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

import { GatewayClient, registerBatchScheme } from "@circle-fin/x402-batching/client";
import {
  ARC,
  ARC_TESTNET_DEPLOYMENT,
  agentNamespacedId,
  arcTestnet,
  ERC8004_AGENT_WALLET_SET_TYPES,
  ERC8004_IDENTITY_EIP712_DOMAIN,
  erc8004For,
  type MarketSymbol,
  marketDeployment,
  marketId as marketIdOf,
  rpcUrl as sharedRpcUrl,
} from "@sidekick/shared";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACCOUNT_MANAGER_ABI,
  erc20Abi,
  GATEWAY_WALLET_ABI,
  IDENTITY_REGISTRY_ABI,
  ORACLE_ADAPTER_ABI,
  PERP_ENGINE_ABI,
  POOL_ABI,
  REPUTATION_REGISTRY_ABI,
  VAULT_ABI,
} from "./abis.ts";
import { BlockStream } from "./stream.ts";
import type {
  AccountView,
  Broadcaster,
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

/** Circle GatewayWallet on Arc testnet — `deposit(token,value)` funds the unified balance (from `CHAIN_CONFIGS.arcTestnet`). */
const GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

/** A block-stream subscriber callback. */
export type BlockHandler = (state: MarketBlockState) => void;

/** The engine `/pay` resource's JSON body (same on the 402-challenge passthrough and the settled 200). */
interface PayBody {
  settled?: boolean;
  reason?: string;
  amount?: string;
  transaction?: string;
}

/** The EIP-712 typed-data the Circle batch scheme asks the signer to sign (matches `@circle-fin/x402-batching`'s `BatchEvmSigner`). */
interface BatchEvmSignTypedDataParams {
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** The minimal signer the Circle batch x402 scheme needs — satisfied by a viem `Account`/wallet. */
interface BatchEvmSigner {
  address: Hex;
  signTypedData: (params: BatchEvmSignTypedDataParams) => Promise<Hex>;
}

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
  private x402HttpInstance?: x402HTTPClient;
  private readonly broadcaster?: Broadcaster;

  constructor(config: SideKickConfig) {
    if (config.network && config.network !== "arc-testnet") {
      throw new Error(`Only "arc-testnet" is live; got "${config.network}"`);
    }
    this.account = config.account ?? privateKeyToAccount(config.privateKey as Hex);
    this.privateKey = config.privateKey;
    this.broadcaster = config.broadcaster;
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
   * Fetch the venue's self-description — the one call that lets an agent self-configure with **zero
   * prior knowledge**: the live markets and their params (m, α, λ, r_max, k), the on-chain contract
   * addresses, the oracle source per market, the block/checkpoint/funding cadence, the units
   * convention, and a live headline snapshot (mark / skew / funding / OI) per market. An agent can
   * discover what to trade and how it's sized purely from this, without importing the deployment.
   */
  async venue(): Promise<import("./types.ts").VenueDescriptor> {
    const res = await fetch(`${this.engineUrl}/venue`);
    if (!res.ok) throw new Error(`engine /venue → ${res.status}`);
    return (await res.json()) as import("./types.ts").VenueDescriptor;
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
    await this.approveIfNeeded(usdc, vault, value);
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
    // Two signer paths, same x402 batch scheme + same gas-free EIP-3009 authorization:
    //   • raw privateKey → Circle's convenience `GatewayClient.pay()`.
    //   • viem/external/Circle-Wallet `account` (no raw key) → the lower-level x402 handshake driven
    //     by `registerBatchScheme({ signer })`. This is what makes the headline flow signer-only, so a
    //     real agent never has to hand over (or even materialize) a private key.
    const data = this.privateKey
      ? (await this.gatewayClient().pay<PayBody>(url, { method: "POST" })).data
      : await this.payViaSigner(url);
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
   * off-chain balance nanopayments draw against), post Vault trading collateral, and optionally
   * establish an ERC-8004 identity — either link an existing `identityId` or `registerIdentity` to
   * mint a fresh one on Arc's canonical registry. Each step is skipped if its option is absent.
   * Idempotent-ish: depositing twice just adds more.
   */
  async onboard(opts: OnboardOptions = {}): Promise<OnboardResult> {
    const out: OnboardResult = { address: this.address };
    if (opts.gatewayUSDC) {
      out.gatewayDepositTx = await this.gatewayDeposit(opts.gatewayUSDC);
    }
    if (opts.depositUSDC) {
      out.vaultDepositTx = await this.deposit(opts.depositUSDC);
      await this.pub.waitForTransactionReceipt({ hash: out.vaultDepositTx });
    }
    if (opts.identityId !== undefined) {
      out.identityTx = await this.linkIdentity(opts.identityId);
    } else if (opts.registerIdentity) {
      const id = await this.registerAgent();
      out.agentId = id.agentId;
      out.identityTx = id.linkTx;
    }
    return out;
  }

  // ── ERC-8004 identity (the real registry, not a stored number) ───────────────────

  /**
   * Register this account as an **ERC-8004 agent** on Arc's canonical Identity Registry, then mirror
   * the minted `agentId` into the venue's AccountManager so the unified-account view carries it.
   *
   * Unlike the old `linkIdentity(arbitraryNumber)` stub, this mints a real, on-chain identity NFT:
   * `register()` on the Identity Registry assigns an `agentId` to `this.address` and sets the agent's
   * payee `agentWallet` to `this.address` by default — i.e. the same EOA that answers margin calls is
   * the canonical, reputation-bearing identity. Returns the minted `agentId` (read from the ERC-721
   * `Transfer(0x0, owner, agentId)` event) and the tx hashes.
   *
   * Costs USDC gas (a real mint). `link: false` skips the in-venue AccountManager link (registry-only).
   */
  async registerAgent(opts: { link?: boolean } = {}): Promise<{
    agentId: bigint;
    registerTx: Hex;
    linkTx?: Hex;
  }> {
    const registry = this.erc8004.identity;
    const registerTx = await this.write(registry, IDENTITY_REGISTRY_ABI, "register", []);
    const receipt = await this.pub.waitForTransactionReceipt({ hash: registerTx });
    const agentId = this.agentIdFromReceipt(receipt, registry);
    let linkTx: Hex | undefined;
    if (opts.link !== false) linkTx = await this.linkIdentity(agentId);
    return { agentId, registerTx, linkTx };
  }

  /**
   * Mirror an already-minted `agentId` into the venue's AccountManager (the in-venue link the
   * unified-account view reads). Separate from {@link registerAgent} so an agent that registered
   * elsewhere can still link. This is the only thing the old `onboard({identityId})` did.
   */
  async linkIdentity(agentId: bigint): Promise<Hex> {
    return this.write(this.deployment.accountManager, ACCOUNT_MANAGER_ABI, "linkIdentity", [
      agentId,
    ]);
  }

  /**
   * Bind a *different* payee wallet to an agentId (e.g. point reputation/payments at a Circle Wallet
   * while a hot EOA registered). The ERC-8004 Identity Registry requires the **new wallet** to prove
   * control via an EIP-712 signature; this method produces that signature with the SDK's signer
   * (so the SDK must be constructed AS the new wallet) and submits it. `deadlineSeconds` bounds the
   * signature's validity from now.
   */
  async setAgentWallet(agentId: bigint, deadlineSeconds = 3600): Promise<Hex> {
    const registry = this.erc8004.identity;
    const owner = (await this.pub.readContract({
      address: registry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "ownerOf",
      args: [agentId],
    })) as Address;
    const latest = await this.pub.getBlock();
    const deadline = latest.timestamp + BigInt(deadlineSeconds);
    const signature = await this.wallet.signTypedData({
      account: this.account,
      domain: {
        name: ERC8004_IDENTITY_EIP712_DOMAIN.name,
        version: ERC8004_IDENTITY_EIP712_DOMAIN.version,
        chainId: this.chainId,
        verifyingContract: registry,
      },
      types: ERC8004_AGENT_WALLET_SET_TYPES,
      primaryType: "AgentWalletSet",
      message: { agentId, newWallet: this.address, owner, deadline },
    });
    return this.write(registry, IDENTITY_REGISTRY_ABI, "setAgentWallet", [
      agentId,
      this.address,
      deadline,
      signature,
    ]);
  }

  /**
   * This account's ERC-8004 identity as the venue sees it: the in-venue linked `agentId` (0 if
   * unlinked), and — when linked — the canonical payee `agentWallet` and the portable namespaced id
   * `eip155:<chainId>:<registry>/<agentId>` an external system resolves reputation by.
   */
  async agentIdentity(): Promise<{
    agentId: bigint;
    linked: boolean;
    agentWallet?: Address;
    namespacedId?: string;
  }> {
    const agentId = (await this.pub.readContract({
      address: this.deployment.accountManager,
      abi: ACCOUNT_MANAGER_ABI,
      functionName: "identityOf",
      args: [this.address],
    })) as bigint;
    if (agentId === 0n) return { agentId, linked: false };
    const agentWallet = (await this.pub.readContract({
      address: this.erc8004.identity,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "getAgentWallet",
      args: [agentId],
    })) as Address;
    return {
      agentId,
      linked: true,
      agentWallet,
      namespacedId: agentNamespacedId(this.chainId, this.erc8004.identity, agentId),
    };
  }

  // ── ERC-8004 reputation (proof-of-payment — the discover→pay→record loop) ────────

  /**
   * Record a settled margin-call **Nanopayment** as on-chain ERC-8004 reputation feedback for an
   * agent — the "record" leg of the agentic loop (discover via `venue` → pay gas-free → record here).
   * Writes a positive feedback entry to the Reputation Registry tagged `sidekick` / `margin-call`,
   * with `feedbackHash = keccak256(txHash)` as the on-chain proof-of-payment anchor (the ERC-8004
   * spec's `proofOfPayment.txHash` lives in the off-chain feedback file this hash commits to).
   *
   * Who calls this: the **venue/engine** is the natural attester (it observed the settlement), but any
   * holder of a SideKick client can record feedback about an agentId. `value` defaults to 1 (a single
   * successful payment); pass a count to batch. Costs USDC gas (a real on-chain write).
   */
  async recordPayment(
    agentId: bigint,
    proof: { txHash: Hex; market?: MarketSymbol; value?: number; feedbackURI?: string },
  ): Promise<Hex> {
    return this.write(this.erc8004.reputation, REPUTATION_REGISTRY_ABI, "giveFeedback", [
      agentId,
      BigInt(proof.value ?? 1), // int128 value
      0, // valueDecimals
      "sidekick", // tag1
      proof.market ? `margin-call:${proof.market}` : "margin-call", // tag2
      this.engineUrl, // endpoint
      proof.feedbackURI ?? "", // feedbackURI (off-chain feedback file, optional)
      keccak256(proof.txHash), // feedbackHash — proof-of-payment anchor (keccak of the settle txHash)
    ]);
  }

  /**
   * An agent's running ERC-8004 reputation summary from the Reputation Registry: how many feedback
   * entries and the aggregate value (optionally filtered to specific client attesters / tags). Lets a
   * counterparty resolve "how trustworthy is this agent" before transacting.
   */
  async reputationSummary(
    agentId: bigint,
    opts: { clients?: Address[]; tag1?: string; tag2?: string } = {},
  ): Promise<{ count: bigint; value: bigint; valueDecimals: number }> {
    const [count, value, valueDecimals] = (await this.pub.readContract({
      address: this.erc8004.reputation,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: "getSummary",
      args: [agentId, opts.clients ?? [], opts.tag1 ?? "", opts.tag2 ?? ""],
    })) as [bigint, bigint, number];
    return { count, value, valueDecimals };
  }

  /** The ERC-8004 registry addresses for this chain (Identity + Reputation). */
  get erc8004() {
    return erc8004For(this.chainId);
  }

  /** Read the minted ERC-721 `agentId` from a `register()` receipt's `Transfer(0x0, owner, id)` log. */
  private agentIdFromReceipt(
    receipt: { logs: Array<{ address: string; topics: readonly Hex[]; data: Hex }> },
    registry: Address,
  ): bigint {
    const TRANSFER_TOPIC =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const; // keccak Transfer(address,address,uint256)
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
      // ERC-721 Transfer: topics = [sig, from(indexed), to(indexed), tokenId(indexed)]
      if (log.topics.length === 4 && log.topics[0] === TRANSFER_TOPIC) {
        const from = BigInt(log.topics[1] as Hex);
        if (from === 0n) return BigInt(log.topics[3] as Hex); // mint (from == address(0))
      }
    }
    throw new Error("register() succeeded but no ERC-721 mint event was found in the receipt");
  }

  /**
   * The underlying Circle `GatewayClient` (buyer side) for this account — read balances, deposit, or
   * pay directly. Lazily constructed.
   *
   * Note: Circle's high-level `GatewayClient` is constructed from a raw key, so this convenience
   * accessor requires the SDK to have been built with `privateKey`. This is a *wrapper* constraint,
   * not a protocol one — the gas-free nanopayment (`answerMarginCall`) works from an external/KMS/
   * Circle-Wallet signer too, because the underlying x402 batch scheme signs with any
   * `{ address, signTypedData }` (see {@link answerMarginCall}). Use `privateKey` only if you need
   * this raw `GatewayClient` handle (e.g. direct `deposit`).
   */
  gateway(): GatewayClient {
    return this.gatewayClient();
  }

  /** This account's Gateway unified balance (available USDC 6dp + formatted). */
  async gatewayBalance(): Promise<{ available: bigint; formatted: string }> {
    const b = await this.gatewayClient().getBalances();
    return { available: b.gateway.available, formatted: b.gateway.formattedAvailable };
  }

  /**
   * Fund this account's Gateway unified balance (what margin-call Nanopayments draw against). Works
   * **signer-only** — no raw key required: it's `USDC.approve(GatewayWallet)` + `GatewayWallet.deposit`,
   * both ordinary contract writes signed by the wallet client. (When constructed with a `privateKey` it
   * uses Circle's convenience `GatewayClient.deposit`, which is identical on-chain.) `amount` is decimal
   * USDC. Returns the deposit tx hash. This is the deposit half of "Gateway is signer-only end-to-end".
   */
  async gatewayDeposit(amount: string): Promise<Hex> {
    if (this.privateKey) {
      const dep = await this.gatewayClient().deposit(amount);
      return dep.depositTxHash as Hex;
    }
    const value = parseUsdc(amount);
    const usdc = this.deployment.usdc;
    await this.approveIfNeeded(usdc, GATEWAY_WALLET_ADDRESS, value);
    return this.write(GATEWAY_WALLET_ADDRESS, GATEWAY_WALLET_ABI, "deposit", [usdc, value]);
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  private gatewayClient(): GatewayClient {
    if (this.gatewayInstance === undefined) {
      if (!this.privateKey) {
        // Only the raw `GatewayClient` handle (direct deposit / balance) needs a raw key — its
        // constructor takes one. The gas-free margin-call flow does NOT: it goes through
        // `payViaSigner` with the account's signer. So this is a narrow constraint, not the headline.
        throw new Error(
          "The raw Circle GatewayClient handle (deposit / getBalances) needs a `privateKey` — its " +
            "constructor takes one. answerMarginCall works without it (signer-only). Construct " +
            "SideKick with `privateKey` only if you need direct gateway().deposit(...).",
        );
      }
      this.gatewayInstance = new GatewayClient({
        chain: GATEWAY_CHAIN,
        privateKey: this.privateKey,
      });
    }
    return this.gatewayInstance;
  }

  /**
   * Answer the x402 margin-call resource using the account's **signer** (no raw key) — the signer-only
   * twin of `GatewayClient.pay()`. Builds an x402 HTTP client registered with the Circle batch scheme
   * (`registerBatchScheme({ signer })`), then runs the 402 → sign → retry handshake by hand:
   *   1. POST the resource → expect HTTP 402 with the Circle Gateway batching payment requirements,
   *   2. `createPaymentPayload(...)` signs an EIP-3009 authorization off-chain via `this.account`,
   *   3. re-POST with the encoded `X-PAYMENT` header → the engine verifies + settles → 200 body.
   * The signer is any `{ address, signTypedData }`, which a viem `Account` (or a Circle Wallet
   * adapter) satisfies — so this is gas-free and key-exposure-free.
   */
  private async payViaSigner(url: string): Promise<PayBody> {
    const http = this.x402Http();
    const first = await fetch(url, { method: "POST" });
    if (first.status !== 402) {
      // The engine returns 200 directly when nothing is owed (no 402 challenge) — pass that through.
      return (await this.safeJson(first)) as PayBody;
    }
    const paymentRequired = http.getPaymentRequiredResponse(
      (name) => first.headers.get(name),
      await this.safeJson(first),
    );
    const payload = await http.createPaymentPayload(paymentRequired);
    const headers = http.encodePaymentSignatureHeader(payload);
    const paid = await fetch(url, { method: "POST", headers });
    return (await this.safeJson(paid)) as PayBody;
  }

  /** Lazily build the x402 HTTP client bound to this account's signer + the Circle batch scheme. */
  private x402Http(): x402HTTPClient {
    if (this.x402HttpInstance === undefined) {
      const client = new x402Client();
      registerBatchScheme(client, { signer: this.batchSigner() });
      this.x402HttpInstance = new x402HTTPClient(client);
    }
    return this.x402HttpInstance;
  }

  /**
   * A `BatchEvmSigner` (`{ address, signTypedData }`) backed by this account. Routes `signTypedData`
   * through the wallet client so it works for a local viem `Account`, a JSON-RPC account, or a Circle
   * Wallet adapter alike — the exact seam that lets the Gateway flow be signer-only. The param shape
   * is the EIP-712 typed-data the Circle batch scheme passes; viem's `signTypedData` takes the same.
   */
  private batchSigner(): BatchEvmSigner {
    return {
      address: this.address,
      signTypedData: (params: BatchEvmSignTypedDataParams) =>
        this.wallet.signTypedData({ account: this.account, ...params }),
    };
  }

  /** Parse a fetch Response as JSON, tolerating an empty/non-JSON body (returns {}). */
  private async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  /**
   * Ensure `spender` is approved for at least `value` of `token`, then wait until it's effective.
   * Routes through {@link write} so it uses the broadcaster (Circle) or the viem wallet as configured.
   * In broadcaster mode `write` already returns a CONFIRMED tx; in viem mode we wait for the receipt.
   */
  private async approveIfNeeded(token: Address, spender: Address, value: bigint): Promise<void> {
    const allowance = (await this.pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.address, spender],
    })) as bigint;
    if (allowance >= value) return;
    const tx = await this.write(token, erc20Abi, "approve", [spender, value]);
    if (!this.broadcaster) await this.pub.waitForTransactionReceipt({ hash: tx });
  }

  /** Send a contract write and return its hash (no wait — callers wait if they need confirmation). */
  // biome-ignore lint/suspicious/noExplicitAny: viem ABI generics over a union of our hand-written ABIs.
  private async write(address: Address, abi: any, functionName: string, args: any[]): Promise<Hex> {
    // Circle (or any custodial) mode: hand the structured call to the broadcaster, which signs +
    // broadcasts via Circle's transaction API (abiFunctionSignature + abiParameters) and returns the
    // on-chain txHash. Default mode: the viem wallet client signs with `this.account` + broadcasts.
    if (this.broadcaster) {
      return this.broadcaster.write({ to: address, abi, functionName, args });
    }
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
