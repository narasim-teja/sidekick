/**
 * Layer B authorization ledger — the off-chain accounting of the per-block payment stream between
 * checkpoints. Each block the §4.3 reconciliation produces *deltas* ("who owes whom, which
 * positions shrank"); those become nanopayment authorizations (Doc 1 §5 Layer B). This ledger is
 * the running record of three distinct flows — kept separate because they are different settlement
 * mechanisms, not the same event seen twice:
 *
 *   - **funding** — the continuous per-block funding stream charged/credited per account.
 *   - **auto-settle** — a margin call the *contract itself* pays inside `checkpoint` from collateral
 *     already custodied in the Vault (the §4.3 settle step). This is an on-chain internal move, NOT
 *     a Gateway nanopayment — it is recorded for the dashboard's operational-flow view only.
 *   - **margin-call** — a *Gateway nanopayment*: USDC the agent proactively pushes from its unified
 *     balance via the x402 `/pay` route (verified + settled off-chain), which the loop then lands
 *     on-chain via `answerMarginCall`. This is the real sub-cent off-chain authorization.
 *
 * The keystone fact (Doc 1 §5): nanopayments (the `margin-call` kind) are NOT per-payment on-chain
 * transactions — they are off-chain signed authorizations against a Gateway unified balance. This
 * ledger is that off-chain truth; the answered x402 amounts feed `answerMarginCall` (landed on-chain
 * before the next reconcile, so solvency sees them) and are periodically reconciled to the chain.
 * All amounts USDC 6dp atomic.
 *
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §5 (the three-layer settlement model)
 */

import { formatUsdc } from "../fixed/units.ts";

/** The kind of Layer B authorization recorded (see the three flows in the file header). */
export type AuthorizationKind = "funding" | "auto-settle" | "margin-call";

/** One authorization the engine records — a funding charge, an auto-settle, or a Gateway top-up. */
export interface Authorization {
  block: number;
  account: string;
  market: string;
  /**
   * - "funding"     — the per-block funding stream.
   * - "auto-settle" — a margin call the contract paid inside `checkpoint` from existing Vault
   *   collateral (an on-chain internal move, not a nanopayment).
   * - "margin-call" — a Gateway nanopayment the agent settled via the x402 `/pay` route (landed
   *   on-chain via `answerMarginCall`).
   */
  kind: AuthorizationKind;
  /** Signed USDC 6dp: + the account receives, − the account pays. */
  amount: bigint;
  /** Wall-clock ms when recorded (for the stream / dashboard). */
  at: number;
}

/** Per-account running totals across the engine's lifetime (USDC 6dp). */
export interface AccountTally {
  /** Net funding cashflow (+ received over the run). */
  fundingNet: bigint;
  /** Total margin-call USDC the contract auto-settled from the account's Vault collateral. */
  autoSettled: bigint;
  /** Total margin-call USDC the account answered via a Gateway nanopayment (x402 `/pay`). */
  marginAnswered: bigint;
  /** Count of authorizations recorded for the account. */
  count: number;
}

/**
 * The Layer B ledger. Append-only stream of authorizations + per-account tallies. Pure in-memory
 * (the durable record is the Gateway unified balance + the periodic on-chain checkpoint); this is
 * the engine's live mirror of it for solvency reads and the dashboard.
 */
export class PaymentLedger {
  private readonly stream: Authorization[] = [];
  private readonly tallies = new Map<string, AccountTally>();
  /**
   * x402-settled margin-call USDC not yet landed on-chain, keyed by `${market}:${account}`. The
   * `/pay` route adds to it on settlement; the loop drains it via `takeAllAnswered` at the top of a
   * tick and lands each via `answerMarginCall`. Persists across ticks until drained (a payment that
   * arrives between ticks must not be lost), so there is no per-block clear.
   */
  private readonly answered = new Map<string, bigint>();
  /** Cumulative funding the pool received, per market (USDC 6dp). */
  private readonly poolFunding = new Map<string, bigint>();

  /** Record a funding cashflow for an account (the continuous funding stream). */
  recordFunding(block: number, market: string, account: string, amount: bigint, at: number): void {
    if (amount === 0n) return;
    this.stream.push({ block, account, market, kind: "funding", amount, at });
    const t = this.tallyOf(account);
    t.fundingNet += amount;
    t.count += 1;
  }

  /** Record the pool's net funding receipt for a market this block. */
  recordPoolFunding(market: string, amount: bigint): void {
    this.poolFunding.set(market, (this.poolFunding.get(market) ?? 0n) + amount);
  }

  /**
   * Record a margin call the *contract* auto-settled inside `checkpoint` from the account's existing
   * Vault collateral (the §4.3 settle step). This is an on-chain internal move, not a Gateway
   * nanopayment — so it is streamed for the dashboard's operational view but does NOT feed
   * `answerMarginCall` (the contract already applied it). `amount` is recorded as a debit (the
   * account's collateral moved into its position margin).
   */
  recordAutoSettle(
    block: number,
    market: string,
    account: string,
    amount: bigint,
    at: number,
  ): void {
    if (amount <= 0n) return;
    this.stream.push({ block, account, market, kind: "auto-settle", amount: -amount, at });
    const t = this.tallyOf(account);
    t.autoSettled += amount;
    t.count += 1;
  }

  /**
   * Record an answered margin call (a settled Gateway nanopayment via the x402 `/pay` route). Adds
   * to the account's answered total AND to the pending `answered` map so the loop lands it on-chain
   * via `answerMarginCall` before the next reconcile (so on-chain margin — and the next checkpoint's
   * solvency — reflect it). `amount` is the USDC the agent paid (recorded as a debit on the stream).
   */
  recordAnsweredCall(
    block: number,
    market: string,
    account: string,
    amount: bigint,
    at: number,
  ): void {
    if (amount <= 0n) return;
    this.stream.push({ block, account, market, kind: "margin-call", amount: -amount, at });
    const t = this.tallyOf(account);
    t.marginAnswered += amount;
    t.count += 1;
    const key = `${market}:${account}`;
    this.answered.set(key, (this.answered.get(key) ?? 0n) + amount);
  }

  /** Margin-call USDC answered (via x402) for an account since last taken, then cleared. */
  takeAnswered(market: string, account: string): bigint {
    const key = `${market}:${account}`;
    const v = this.answered.get(key) ?? 0n;
    this.answered.delete(key);
    return v;
  }

  /**
   * Drain every account's answered (x402-settled) USDC for a market that hasn't been landed on-chain
   * yet, clearing each as it is taken. The loop calls this at the top of a tick to land all payments
   * that arrived since the last tick via `answerMarginCall`. Returns `[account, amount]` pairs.
   */
  takeAllAnswered(market: string): Array<[string, bigint]> {
    const prefix = `${market}:`;
    const out: Array<[string, bigint]> = [];
    for (const [key, amount] of this.answered) {
      if (!key.startsWith(prefix)) continue;
      if (amount > 0n) out.push([key.slice(prefix.length), amount]);
      this.answered.delete(key);
    }
    return out;
  }

  /**
   * Re-queue an answered amount whose on-chain `answerMarginCall` landing failed, so a later tick
   * retries it. Only touches the pending map — the stream + tally already recorded the settlement
   * (the off-chain Gateway payment did happen), so there is no double-count.
   */
  requeueAnswered(market: string, account: string, amount: bigint): void {
    if (amount <= 0n) return;
    const key = `${market}:${account}`;
    this.answered.set(key, (this.answered.get(key) ?? 0n) + amount);
  }

  /** Account tally (creating a zeroed one on first touch). */
  tallyOf(account: string): AccountTally {
    let t = this.tallies.get(account);
    if (!t) {
      t = { fundingNet: 0n, autoSettled: 0n, marginAnswered: 0n, count: 0 };
      this.tallies.set(account, t);
    }
    return t;
  }

  /** The most recent `n` authorizations (for the dashboard's live settlement stream). */
  recent(n = 50): Authorization[] {
    return this.stream.slice(-n);
  }

  /** Total authorizations recorded over the engine's lifetime. */
  get totalAuthorizations(): number {
    return this.stream.length;
  }

  /** Cumulative funding the pool received for a market (USDC 6dp). */
  poolFundingOf(market: string): bigint {
    return this.poolFunding.get(market) ?? 0n;
  }

  /** A compact human summary for logs. */
  summary(): string {
    return `${this.stream.length} authorizations, ${this.tallies.size} accounts`;
  }

  /** Format an authorization for a log line. */
  static format(a: Authorization): string {
    const dir = a.amount >= 0n ? "+" : "-";
    return `[blk ${a.block}] ${a.kind} ${a.account.slice(0, 8)}… ${dir}${formatUsdc(a.amount < 0n ? -a.amount : a.amount)} USDC`;
  }
}
