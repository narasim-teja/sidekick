/**
 * The SideKick engine service (Phase 3) — the live per-block loop wrapped in a Hono service.
 *
 *   - Subscribes to Arc blocks over WebSocket (the ~2s heartbeat from Spike A).
 *   - On each block, runs the §4.3 reconciliation for every configured market (Layer A), records
 *     the funding + margin-call stream (Layer B), and triggers the on-chain `checkpoint` at the
 *     cadence.
 *   - Broadcasts each market's {@link MarketBlockState} to WebSocket subscribers, and serves the
 *     latest state + status over REST. Exposes the x402 margin-call pay resource (Layer B seller).
 *   - Graceful fallback: if it falls behind the 2s cadence, it coalesces — it always reconciles on
 *     the newest block and never queues stale ones (per-block is the target; every-N is safe).
 *
 * This file owns process wiring; the pure loop is in `loop.ts`, the math in `fixed/`, the chain I/O
 * in `chain/`, and Layer B in `payments/`. `index.ts` is the entry point that constructs + starts it.
 */

import {
  BLOCK_SECONDS,
  erc8004For,
  FUNDING_PERIOD_SECONDS,
  getEffectiveMarket,
  getMarket,
  type MarketSymbol,
  marketId as marketIdOf,
  resolveMaintenanceM,
  resolveOracle,
} from "@sidekick/shared";
import { Hono } from "hono";
import type { Address, PublicClient } from "viem";
import { AccountTracker } from "./chain/accounts.ts";
import {
  ARC_LOGS_MAX_RANGE,
  logsClient,
  operatorAccount,
  operatorWallet,
  publicClient,
  wsClient,
} from "./chain/clients.ts";
import { Venue } from "./chain/venue.ts";
import type { Cadence } from "./compute/reconcile.ts";
import { BLOCK_SECONDS_BIG, ENGINE_VERSION, FUNDING_PERIOD_BIG } from "./config.ts";
import {
  type LoopDeps,
  type MarketRuntime,
  makeMarketRuntime,
  runMarketTick,
  toSettlementEvents,
} from "./loop.ts";
import { assertAdapterSource, makeOracle, resolveForceSynthetic } from "./oracle/index.ts";
import { PaymentLedger } from "./payments/ledger.ts";
import { paymentRoutes } from "./payments/routes.ts";
import { GatewaySeller } from "./payments/seller.ts";
import type {
  EngineStatus,
  MarketBlockState,
  VenueDescriptor,
  VenueMarketDescriptor,
} from "./state.ts";

/** Engine configuration. */
export interface EngineConfig {
  /** Markets to loop over. Defaults to BTC-PERP (the live-Stork market). */
  markets?: MarketSymbol[];
  /** Checkpoint on-chain every N Arc blocks (1 = every block; >1 = graceful fallback). Default 1. */
  checkpointEveryBlocks?: number;
  /** Block to start the account backfill from (0 = genesis scan; default = recent head − 5000). */
  fromBlock?: bigint;
  /** Env (for tests). */
  env?: Record<string, string | undefined>;
}

/** A subscriber callback for per-block state (the WS bridge registers one). */
type Subscriber = (state: MarketBlockState) => void;

export class EngineService {
  readonly app: Hono;
  private readonly pub: PublicClient;
  private readonly ws: PublicClient;
  private readonly venue: Venue;
  private readonly tracker: AccountTracker;
  private readonly ledger = new PaymentLedger();
  private readonly seller: GatewaySeller;
  private readonly runtimes = new Map<MarketSymbol, MarketRuntime>();
  private readonly latest = new Map<MarketSymbol, MarketBlockState>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly checkpointEveryBlocks: number;
  private readonly markets: MarketSymbol[];
  private readonly operator: Address;
  private readonly env: Record<string, string | undefined>;
  private unwatch?: () => void;
  private running = false;
  private busy = false;
  private pendingBlock: number | null = null;

  constructor(config: EngineConfig = {}) {
    const env = config.env ?? process.env;
    this.env = env;
    this.markets = config.markets ?? ["BTC-PERP"];
    this.checkpointEveryBlocks = config.checkpointEveryBlocks ?? 1;
    this.pub = publicClient(env);
    this.ws = wsClient(env);
    this.venue = new Venue(this.pub, operatorWallet(env));
    this.operator = operatorAccount(env).address;
    this.seller = new GatewaySeller({ sellerAddress: this.operator });
    // Scan logs on the PUBLIC Arc RPC (10k-block range), not the per-block read client (Alchemy
    // free-tier caps getLogs at 10 blocks). Backfill starts at the venue's deployment block.
    this.tracker = new AccountTracker(
      logsClient(env),
      this.venue.deployment.perpEngine,
      this.markets,
      config.fromBlock ?? this.venue.deployment.deploymentBlock,
      ARC_LOGS_MAX_RANGE,
    );

    for (const symbol of this.markets) {
      const market = this.venue.market(symbol);
      const oracle = makeOracle(this.pub, getMarket(symbol), market.oracleAdapter, env);
      if (oracle.isForcedSynthetic) {
        this.log(
          `[${symbol}] MARK_MODE=synthetic — serving the DRIFT walk (drift ${env.SYNTH_DRIFT_PER_BLOCK ?? "0"}/blk, ` +
            `vol ${env.SYNTH_VOL_PER_BLOCK ?? "default"}/blk), NOT the live feed. Marks are tagged synthetic-fallback. ` +
            `This is the demo knob that makes margin calls (and x402 nanopayments) fire on camera.`,
        );
      }
      this.runtimes.set(symbol, makeMarketRuntime(symbol, oracle, env));
    }

    this.app = this.buildApp();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  /** Start the loop: backfill accounts, then drive a reconcile on every new Arc block. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Guard: the on-chain adapter must actually report the source we resolved off-chain, so a
    // `chainlink` resolution can never be read off a StorkAdapter and mislabeled `chainlink-live`.
    await this.assertAdapterSources();
    // Sync the demo maintenance fraction on-chain so the contract's `m` matches what the engine
    // predicts off-chain (preserving the §4.3 mirror). No-op unless DEMO_MAINTENANCE_M differs from
    // what's already deployed; non-fatal if the operator isn't the registry owner.
    await this.syncMaintenanceMargin();
    await this.tracker.backfill();
    this.log(
      `backfill complete; looping ${this.markets.join(", ")} (checkpoint every ${this.checkpointEveryBlocks} block(s))`,
    );

    this.unwatch = this.ws.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (bn) => this.onBlock(Number(bn)),
      onError: (err) => this.log(`block watch error: ${err.message}`),
    });
  }

  /** Stop the loop and close the block subscription. */
  stop(): void {
    this.running = false;
    this.unwatch?.();
    this.unwatch = undefined;
  }

  /**
   * Block handler with coalescing: if a reconcile is still running when a new block arrives, we
   * remember only the newest pending block and run it once free — never queueing stale blocks (the
   * graceful "always reconcile the newest" fallback).
   */
  private onBlock(arcBlock: number): void {
    if (!this.running) return;
    if (this.busy) {
      this.pendingBlock = arcBlock;
      return;
    }
    void this.drain(arcBlock);
  }

  private async drain(arcBlock: number): Promise<void> {
    this.busy = true;
    try {
      await this.reconcileAll(arcBlock);
    } catch (err) {
      this.log(
        `reconcile error @ block ${arcBlock}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (this.env.DEBUG_RECONCILE && err instanceof Error) {
        // Surface the underlying transport failure — the top-level message is a generic
        // "HTTP request failed"; the `cause` chain (viem) carries the real RPC method/URL/status.
        const cause = (err as { cause?: unknown }).cause;
        this.log(`  ↳ detail: ${err.stack?.split("\n").slice(0, 4).join(" | ")}`);
        if (cause) this.log(`  ↳ cause: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } finally {
      this.busy = false;
      const next = this.pendingBlock;
      this.pendingBlock = null;
      if (next !== null && this.running) void this.drain(next);
    }
  }

  /**
   * Cross-check that each market's deployed adapter reports the source we resolved from env. Runs
   * once at boot (the `source()` call is a free `pure` view). A mismatch means the on-chain
   * `ORACLE_SOURCE_<MARKET>` (deploy) and the engine's resolution disagree — fail loudly rather than
   * read a Stork feed while claiming Chainlink provenance.
   */
  private async assertAdapterSources(): Promise<void> {
    await Promise.all(
      this.markets.map((symbol) => {
        // Forced-synthetic markets never read their on-chain adapter, so a provenance cross-check is
        // moot — skip it (a misregistered but unused adapter shouldn't block a synthetic-mark demo).
        if (resolveForceSynthetic(symbol, this.env)) return Promise.resolve();
        const market = this.venue.market(symbol);
        const expected = resolveOracle(symbol, this.env).source;
        return assertAdapterSource(this.pub, market.oracleAdapter, expected);
      }),
    );
  }

  /**
   * Push the configured maintenance fraction `m` (`DEMO_MAINTENANCE_M`, else the swept 1%) on-chain
   * for every market, so `MarketRegistry` agrees with the value the engine reconciles against. This
   * is the lever that makes margin calls — and the x402 nanopayments that answer them — actually
   * reachable: at the production m=1% an agent's equity must crater ~99% before it is ever called, so
   * the headline flow never fires on a gentle mark move. Each market is a no-op if its on-chain `m`
   * already matches (safe to run every boot). A revert (e.g. the operator isn't the registry owner)
   * is logged, NOT fatal — the engine still runs, just with whatever `m` is already on-chain (and the
   * dashboard would then show the off-chain override while the contract calls at the old line; the log
   * makes that visible). Switching the demo on/off is purely the env value — no code change.
   */
  private async syncMaintenanceMargin(): Promise<void> {
    const m = resolveMaintenanceM(this.env);
    for (const symbol of this.markets) {
      try {
        const res = await this.venue.syncMaintenanceM(symbol, m);
        if (res.changed) {
          const ok = await this.venue.confirm(res.txHash as `0x${string}`);
          const pct = (m * 100).toFixed(2);
          this.log(
            ok
              ? `[${symbol}] maintenance m → ${pct}% on-chain (was ${(Number(res.from) / 1e16).toFixed(2)}%) ${res.txHash}`
              : `[${symbol}] setParams(m=${pct}%) reverted: ${res.txHash} — contract keeps its old m`,
          );
        }
      } catch (err) {
        // Most likely the operator wallet isn't the registry owner. Non-fatal: the demo can still run
        // against the live oracle, but a forced-synthetic margin-call demo needs this to land.
        this.log(
          `[${symbol}] could not sync maintenance m on-chain (non-fatal): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        );
      }
    }
  }

  /** Reconcile every market at the given Arc block. */
  private async reconcileAll(arcBlock: number): Promise<void> {
    const deps = this.loopDeps();
    for (const symbol of this.markets) {
      const rt = this.runtimes.get(symbol);
      if (!rt) continue;
      const state = await runMarketTick(rt, arcBlock, deps);
      this.latest.set(symbol, state);
    }
  }

  /** Run a single reconcile tick for all markets at the chain head (for tests / manual stepping). */
  async tickOnce(): Promise<MarketBlockState[]> {
    const head = Number(await this.pub.getBlockNumber());
    await this.tracker.backfill();
    await this.reconcileAll(head);
    return this.markets.map((s) => this.latest.get(s)).filter((s): s is MarketBlockState => !!s);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────

  private loopDeps(): LoopDeps {
    const cadence: Cadence = { blockSeconds: BLOCK_SECONDS_BIG, periodSeconds: FUNDING_PERIOD_BIG };
    return {
      venue: this.venue,
      tracker: this.tracker,
      ledger: this.ledger,
      cadence,
      checkpointEveryBlocks: this.checkpointEveryBlocks,
      emit: (state) => this.broadcast(state),
      log: (m) => this.log(m),
    };
  }

  /** The open margin-call shortfall for an account in a market (the x402 resource price). */
  private shortfall(market: MarketSymbol, account: string): bigint {
    const state = this.latest.get(market);
    if (!state) return 0n;
    const pos = state.positions.find((p) => p.account.toLowerCase() === account.toLowerCase());
    if (!pos) return 0n;
    // `call` minus `paid` is what is still owed this block (decimal USDC → 6dp).
    const owed = toAtomic(pos.call) - toAtomic(pos.paid);
    return owed > 0n ? owed : 0n;
  }

  private broadcast(state: MarketBlockState): void {
    this.latest.set(state.market, state);
    for (const sub of this.subscribers) sub(state);
  }

  /** Register a subscriber (the WS bridge); returns an unsubscribe fn. */
  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private status(): EngineStatus {
    const ticks: Record<string, number> = {};
    for (const [s, rt] of this.runtimes) ticks[s] = rt.tick;
    return {
      running: this.running,
      chainId: this.venue.deployment.chainId,
      operator: this.operator,
      markets: this.markets,
      checkpointEveryBlocks: this.checkpointEveryBlocks,
      totalAuthorizations: this.ledger.totalAuthorizations,
      ticks,
    };
  }

  /**
   * The venue self-description (`GET /venue`): everything an external agent needs to self-configure
   * with zero prior knowledge — chain, shared contracts, per-market params + addresses + a live
   * headline snapshot, cadence, and the units convention. Built fresh each call so the `live` block
   * reflects the latest reconciled state.
   */
  private descriptor(): VenueDescriptor {
    const dep = this.venue.deployment;
    const markets: VenueMarketDescriptor[] = this.markets.map((symbol) => {
      const cfg = getEffectiveMarket(symbol, this.env);
      const md = dep.markets[symbol];
      const s = this.latest.get(symbol);
      // Resolve the oracle from env (not the static MARKETS literal) so /venue reflects the live
      // boot-time source choice (`ORACLE_SOURCE_<MARKET>`), matching what the loop actually reads.
      const resolved = resolveOracle(symbol, this.env);
      return {
        symbol,
        name: cfg.name,
        asset: cfg.asset,
        marketId: marketIdOf(symbol),
        params: {
          m: cfg.params.m,
          alpha: cfg.params.alpha,
          lambda: cfg.params.lambda,
          rMax: cfg.params.rMax,
          k: cfg.params.k,
        },
        oracle: {
          source: resolved.source,
          assetId: resolved.source === "stork" ? resolved.assetId : resolved.feedId,
        },
        contracts: {
          pool: md?.pool ?? "",
          lpToken: md?.lpToken ?? "",
          oracleAdapter: md?.oracleAdapter ?? "",
        },
        live: s
          ? {
              mark: s.mark,
              markProvenance: s.markProvenance,
              skew: s.skew,
              fundingRate: s.fundingRate,
              oiLong: s.oiLong,
              oiShort: s.oiShort,
              poolCapital: s.pool.capital,
            }
          : null,
      };
    });
    return {
      name: "sidekick",
      version: ENGINE_VERSION,
      chainId: dep.chainId,
      deploymentBlock: Number(dep.deploymentBlock),
      operator: this.operator,
      contracts: {
        usdc: dep.usdc,
        vault: dep.vault,
        marketRegistry: dep.marketRegistry,
        perpEngine: dep.perpEngine,
        accountManager: dep.accountManager,
      },
      erc8004: (() => {
        const r = erc8004For(dep.chainId);
        return {
          identity: r.identity,
          reputation: r.reputation,
          namespace: `eip155:${dep.chainId}`,
        };
      })(),
      cadence: {
        blockSeconds: BLOCK_SECONDS,
        checkpointEveryBlocks: this.checkpointEveryBlocks,
        fundingPeriodSeconds: FUNDING_PERIOD_SECONDS,
      },
      units: {
        collateral: "USDC",
        collateralDecimals: 6,
        markDecimals: 18,
        amountsInPayloads: "decimal-string",
      },
      markets,
    };
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────────

  private buildApp(): Hono {
    const app = new Hono();

    app.get("/", (c) => c.json({ name: "sidekick-engine", status: "ok" }));
    app.get("/status", (c) => c.json(this.status()));
    // Self-description: a brand-new agent fetches this to learn the venue (markets, params,
    // addresses, cadence, live headline numbers) with zero prior knowledge.
    app.get("/venue", (c) => c.json(this.descriptor()));
    app.get("/state", (c) => c.json([...this.latest.values()]));
    app.get("/state/:market", (c) => {
      const s = this.latest.get(c.req.param("market") as MarketSymbol);
      return s ? c.json(s) : c.json({ error: "no state yet" }, 404);
    });
    // Serialize to the same JSON-safe SettlementEvent shape the WS stream uses (signed decimal-string
    // amounts) — `recent()` returns raw bigint-amount Authorizations, which `c.json` cannot stringify.
    app.get("/settlement", (c) => c.json(toSettlementEvents(this.ledger.recent(100))));

    // Layer B: the x402 margin-call pay resource.
    app.route(
      "/",
      paymentRoutes({
        seller: this.seller,
        ledger: this.ledger,
        currentTick: (m) => this.runtimes.get(m)?.tick ?? 0,
        shortfall: (m, a) => this.shortfall(m, a),
        log: (msg) => this.log(msg),
      }),
    );

    return app;
  }

  private log(msg: string): void {
    console.log(`[engine] ${msg}`);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────

/** Parse a decimal USDC string (possibly signed) to 6dp atomic. */
function toAtomic(decimal: string): bigint {
  const neg = decimal.startsWith("-");
  const body = neg ? decimal.slice(1) : decimal;
  const [whole, frac = ""] = body.split(".");
  const v = BigInt(whole || "0") * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6) || "0");
  return neg ? -v : v;
}
