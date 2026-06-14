/**
 * Deterministic demo replay, the dashboard's fallback when the live engine is unreachable.
 *
 * A cold Vercel URL (no local engine) must NEVER be blank for a judge. So this module synthesizes a
 * faithful, on-thesis sequence of {@link MarketBlockState} frames that exercises every panel and
 * follows the Doc 3 §11 demo arc:
 *
 *   1. long + short open early, the per-block loop is alive, the book has two sides.
 *   2. the funding-strategy agent (hero) opens, rides the funding-receiving side.
 *   3. the long pushes skew, convex funding ramps, the OI cap tightens.
 *   4. the MM arrives, takes the balancing side, skew self-corrects.
 *   5. the dark agent goes silent, decrements smoothly toward zero (no liquidation).
 *
 * The math is the real venue math (Doc 1 §4): EMA-smoothed skew, the convex clamped funding rate
 * `clamp(α·S·|S|, ±r_max)`, the per-block payment `N·rate·(Δt/T)`, and the §4.2 decrement
 * `N' = E/m`. It runs on a seeded PRNG so the replay is identical every load (the same backup
 * property the Phase-1 sim has). This is a *visualization* of the venue, honestly badged REPLAY in
 * the UI, not a claim of a live run.
 *
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §4 (the formulas this mirrors)
 * @see docs/03-JUDGE-EXPLAINER.md §11 (the demo sequence)
 */

import type {
  AuthorizationKind,
  MarketBlockState,
  PositionState,
  SettlementEvent,
} from "./types.ts";
import { DEMO_AGENT_ADDRESSES } from "./venue.ts";

// Phase-1 swept constants (Doc 1 §4.1): m=0.01, α=r_max, λ=0.08, r_max=5e-4, k=3.
const PARAMS = { m: 0.01, alpha: 0.0005, lambda: 0.08, rMax: 0.0005, k: 3 };
const BLOCK_SECONDS = 2;
const FUNDING_PERIOD_SECONDS = 8 * 60 * 60;
const DT_OVER_T = BLOCK_SECONDS / FUNDING_PERIOD_SECONDS;

/** Demo agent addresses, the single source of truth (also the dashboard's role labels) lives in `venue.ts`. */
const ADDR = DEMO_AGENT_ADDRESSES;

interface SimPosition {
  account: string;
  side: "long" | "short";
  notional: number;
  margin: number;
  entryMark: number;
  /** Whether this agent answers margin calls (false = the dark agent). */
  answers: boolean;
  /** Whether it answers via the x402 Gateway nanopayment (true) or relies on auto-settle (false). */
  viaGateway: boolean;
  openAt: number;
  alive: boolean;
}

/** A mulberry32 seeded PRNG, deterministic, no deps. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-position equity at a mark = margin + price PnL (long: +(mark−entry)/entry·N). */
function equity(p: SimPosition, mk: number): number {
  const dir = p.side === "long" ? 1 : -1;
  const pricePnl = (dir * (mk - p.entryMark) * p.notional) / p.entryMark;
  return p.margin + pricePnl;
}

/** The whole replay state, advanced one block per `step()`. */
export class DemoReplay {
  readonly market = "ETH-PERP";
  private tick = 0;
  private arcBlock = 47_000_000;
  private price = 3200;
  private smoothSkew = 0;
  private poolCapital = 60;
  private gapFund = 0.5;
  private poolFundingAccrued = 0;
  private checkpointIndex = 0;
  private readonly rand: () => number;
  private positions: SimPosition[] = [];
  private settlementTail: SettlementEvent[] = [];

  constructor(seed = 0x51de) {
    this.rand = rng(seed);
  }

  /** Advance one block and return the resulting per-block state (the same shape the WS pushes). */
  step(): MarketBlockState {
    this.tick += 1;
    this.arcBlock += 1;
    this.stageEntries();

    // Price: a deterministic scripted arc (with light jitter) so every thesis beat fires reliably on a
    // loop, this is a demo replay, so we shape the mark rather than hope GBM erodes the dark agent. A
    // sustained down-leg after the dark 20x-long opens (blk 9) walks it through smooth decrement; the
    // mark then recovers so the loop reads cleanly when it repeats. Jitter keeps it alive, not robotic.
    const jitter = (this.rand() - 0.5) * 2 * 0.0009;
    this.price *= 1 + this.scriptedDrift() + jitter;

    const live = this.positions.filter((p) => p.alive);
    const oiLong = live.filter((p) => p.side === "long").reduce((a, p) => a + p.notional, 0);
    const oiShort = live.filter((p) => p.side === "short").reduce((a, p) => a + p.notional, 0);
    const total = oiLong + oiShort;
    const skew = total > 0 ? (oiLong - oiShort) / total : 0;

    // EMA-smoothed skew → convex, clamped funding rate (Doc 1 §4.1).
    this.smoothSkew = PARAMS.lambda * skew + (1 - PARAMS.lambda) * this.smoothSkew;
    const ss = this.smoothSkew;
    const raw = PARAMS.alpha * ss * Math.abs(ss);
    const fundingRate = Math.max(-PARAMS.rMax, Math.min(PARAMS.rMax, raw));

    const events: SettlementEvent[] = [];
    const positionStates: PositionState[] = [];

    for (const p of live) {
      const notionalBefore = p.notional;
      // 1. mark → equity at the new price.
      let eq = equity(p, this.price);
      // 2. fund: rate>0 (book net long) → longs pay, shorts receive. Pool takes the other side.
      const dir = p.side === "long" ? -1 : 1; // sign of the cashflow to THIS position
      const fundingPay = dir * fundingRate * p.notional * DT_OVER_T;
      eq += fundingPay;
      p.margin += fundingPay;
      this.poolFundingAccrued -= fundingPay;
      if (Math.abs(fundingPay) > 1e-9) {
        events.push(this.event(p.account, "funding", fundingPay));
      }

      // 3. check against post-funding equity; 4-6 call / settle / decrement (Doc 1 §4.3).
      const required = PARAMS.m * p.notional;
      let outcome: PositionState["outcome"] = "healthy";
      let call = 0;
      let paid = 0;
      if (eq < required) {
        call = required - eq;
        if (p.answers && p.margin >= 0) {
          // The agent cures the call. viaGateway → the headline x402 nanopayment; else auto-settle.
          const kind: AuthorizationKind = p.viaGateway ? "margin-call" : "auto-settle";
          paid = call;
          p.margin += paid;
          eq += paid;
          outcome = "topped-up";
          events.push(this.event(p.account, kind, +paid));
        } else if (eq > 0) {
          // No-pay path → decrement to maintenance-adequate: N' = E/m (Doc 1 §4.2). After the cut the
          // position's margin equals its equity (eq backs N'·m exactly). The margin the trader lost on
          // the closed slice (p.margin − eq) is the pool's gain as counterparty, conservation: the
          // pool is −Σ(trader PnL), realized PnL books into pool capital on every close/decrement.
          this.poolCapital += Math.max(0, p.margin - eq);
          p.notional = eq / PARAMS.m;
          p.margin = eq;
          // Re-anchor the entry to the current mark: the retained slice has had its price PnL realized
          // into `margin`, so it must NOT be re-counted next block. (Forgetting this re-applies the full
          // since-open loss every block and gaps the position, the exact double-count the §4.3 ordering
          // is designed to prevent.)
          p.entryMark = this.price;
          outcome = "decrement";
          if (p.notional < 1) {
            p.alive = false;
            p.notional = 0;
          }
        } else {
          // E ≤ 0 → close fully, draw from the gap fund (the only bad-debt sink).
          this.gapFund = Math.max(0, this.gapFund + eq);
          p.alive = false;
          outcome = "gap";
          p.notional = 0;
        }
      }

      positionStates.push({
        account: p.account,
        side: p.side,
        notionalBefore: notionalBefore.toFixed(6),
        notionalAfter: p.notional.toFixed(6),
        equity: eq.toFixed(6),
        funding: fundingPay.toFixed(6),
        call: call.toFixed(6),
        paid: paid.toFixed(6),
        outcome,
      });
    }

    // Pool: net exposure = |netQty|·mark; the Layer-2 cap is k·capital.
    const netNotional = Math.abs(oiLong - oiShort);
    const cap = PARAMS.k * this.poolCapital;
    const poolEquity = this.poolCapital + this.poolFundingAccrued;

    // Keep a rolling settlement tail (last 60) so the stream/3D view has history on first paint.
    this.settlementTail = [...this.settlementTail, ...events].slice(-60);

    // A checkpoint lands every block in the replay (checkpointEveryBlocks = 1), with a synthetic hash.
    this.checkpointIndex += 1;
    const checkpoint = {
      txHash: this.fakeHash(),
      index: this.checkpointIndex,
    };

    return {
      market: this.market,
      tick: this.tick,
      arcBlock: this.arcBlock,
      mark: this.price.toFixed(6),
      markProvenance: "synthetic-fallback",
      skew,
      smoothSkew: this.smoothSkew,
      fundingRate,
      oiLong: oiLong.toFixed(6),
      oiShort: oiShort.toFixed(6),
      positions: positionStates,
      pool: {
        capital: this.poolCapital.toFixed(6),
        gapFund: this.gapFund.toFixed(6),
        exposure: netNotional.toFixed(6),
        cap: cap.toFixed(6),
        equity: poolEquity.toFixed(6),
        fundingAccrued: this.poolFundingAccrued.toFixed(6),
      },
      settlement: this.settlementTail.slice(-12),
      checkpoint,
      at: this.now(),
    };
  }

  /** Stage agent entries on the Doc 3 §11 schedule. */
  private stageEntries(): void {
    const open = (
      account: string,
      side: "long" | "short",
      collateral: number,
      leverage: number,
      answers: boolean,
      viaGateway: boolean,
    ) => {
      this.positions.push({
        account,
        side,
        notional: collateral * leverage,
        margin: collateral,
        entryMark: this.price,
        answers,
        viaGateway,
        openAt: this.tick,
        alive: true,
      });
    };
    // Notionals are scaled for legibility, at $1-margin testnet sizes funding rounds below the 6dp
    // dust floor (the exact artifact Doc 2 §4.4 hit live), so the demo uses realistic notionals where
    // the per-block funding + decrement are visible. These are display values, not real testnet USDC.
    // Answerers (long/funding) are opened thin, high leverage, little excess margin, so the gentle
    // adverse leg calls them within a handful of blocks and they cure every block (a rich, early
    // settlement stream). The short/MM run safer (they balance the book and rarely get called).
    switch (this.tick) {
      case 2:
        // Long: thin + levered → margin-called on the down-leg, cures via AUTO-SETTLE (Vault collateral).
        open(ADDR.long, "long", 26, 12, true, false);
        open(ADDR.short, "short", 90, 2, true, true);
        break;
      case 5:
        // The hero: thin + levered → called on the leg and it answers via the Gateway NANOPAYMENT (the
        // headline x402 path fires on camera, the whole-thesis centerpiece).
        open(ADDR.funding, "long", 18, 14, true, true);
        break;
      case 7:
        // The dark agent: VERY thin (opened close to its maintenance floor) + high leverage, never
        // answers → it begins decrementing within a few blocks and trims smoothly toward zero. Thin so
        // the no-liquidation proof reads quickly, not after a long wait.
        open(ADDR.dark, "long", 8, 20, false, false);
        break;
      case 9: {
        // The long pushes skew (adds size) so convex funding + the OI cap become visible on the gauge.
        const lng = this.positions.find((p) => p.account === ADDR.long && p.alive);
        if (lng) lng.notional += 700;
        break;
      }
      case 13:
        // The MM arrives on the balancing (short) side → skew self-corrects.
        open(ADDR.mm, "short", 180, 3, true, true);
        break;
    }
  }

  /**
   * The deterministic per-block return that shapes the demo arc (a repeating ~96-block cycle so the
   * narrative loops): flat while the book builds, a sustained down-leg once the dark 20x-long is open
   * (blocks ~14-40) that erodes its thin margin into smooth decrements, then a recovery so the next
   * cycle reads clean. Magnitudes are small per block (≤ ~0.4%), realistic, not a crash.
   */
  private scriptedDrift(): number {
    const phase = this.tick % 110;
    if (phase < 9) return 0.0005; // brief build, the book forms two-sided
    if (phase < 64) return -0.0019; // gentle adverse leg, calls the levered answerers every block (rich
    //                                 nanopayment stream) and walks the silent dark long through SMOOTH,
    //                                 repeated decrements; the per-block loss never exceeds the position's
    //                                 equity, so it trims toward zero and never gaps (no cliff).
    if (phase < 76) return -0.0002; // taper
    if (phase < 104) return 0.0026; // recovery, positions heal, the book rebuilds before the loop repeats
    return 0.0005;
  }

  private event(account: string, kind: AuthorizationKind, amount: number): SettlementEvent {
    return {
      block: this.tick,
      account,
      kind,
      amount: amount.toFixed(6),
      at: this.now(),
    };
  }

  /** A deterministic ms timestamp so the replay is reproducible (no Date.now in the stepper). */
  private now(): number {
    // Anchor at a fixed epoch + tick·blocktime so `ago()` reads sensibly without real wall-clock.
    return 1_750_000_000_000 + this.tick * BLOCK_SECONDS * 1000;
  }

  private fakeHash(): string {
    let h = "0x";
    for (let i = 0; i < 64; i++) h += Math.floor(this.rand() * 16).toString(16);
    return h;
  }
}
