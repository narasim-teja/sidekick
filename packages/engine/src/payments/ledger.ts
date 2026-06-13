/**
 * Layer B authorization ledger — the off-chain accounting of the per-block payment stream between
 * checkpoints. Each block the §4.3 reconciliation produces *deltas* ("who owes whom, which
 * positions shrank"); those become nanopayment authorizations (Doc 1 §5 Layer B). This ledger is
 * the running record of:
 *
 *   - **funding** charged/credited per account (the continuous funding stream),
 *   - **margin calls** requested and how much each account has *answered* (settled via Gateway),
 *   - the resulting **settled top-ups** that land on-chain via `answerMarginCall`.
 *
 * The keystone fact (Doc 1 §5): nanopayments are NOT per-payment on-chain transactions — they are
 * off-chain signed authorizations against a Gateway unified balance. This ledger is that off-chain
 * truth; it feeds next-block solvency (the engine reads answered amounts before the next reconcile)
 * and is periodically reconciled to the chain. All amounts USDC 6dp atomic.
 *
 * @see docs/01-PROJECT-AND-ARCHITECTURE.md §5 (the three-layer settlement model)
 */

import { formatUsdc } from "../fixed/units.ts";

/** One authorization the engine records — a funding charge or an answered margin call. */
export interface Authorization {
  block: number;
  account: string;
  market: string;
  /** "funding" = the per-block funding stream; "margin-call" = an answered solvency top-up. */
  kind: "funding" | "margin-call";
  /** Signed USDC 6dp: + the account receives, − the account pays. */
  amount: bigint;
  /** Wall-clock ms when recorded (for the stream / dashboard). */
  at: number;
}

/** Per-account running totals across the engine's lifetime (USDC 6dp). */
export interface AccountTally {
  /** Net funding cashflow (+ received over the run). */
  fundingNet: bigint;
  /** Total margin-call USDC the account has answered (settled top-ups). */
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
  /** Margin-call USDC answered this block, keyed by `${market}:${account}` — read by the loop. */
  private answeredThisBlock = new Map<string, bigint>();
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
   * Record an answered margin call (a settled Gateway nanopayment). Adds to the account's answered
   * total AND to `answeredThisBlock` so the loop can land it on-chain via `answerMarginCall` and
   * feed it into the next reconcile.
   */
  recordAnsweredCall(
    block: number,
    market: string,
    account: string,
    amount: bigint,
    at: number,
  ): void {
    if (amount <= 0n) return;
    this.stream.push({ block, account, market, kind: "margin-call", amount, at });
    const t = this.tallyOf(account);
    t.marginAnswered += amount;
    t.count += 1;
    const key = `${market}:${account}`;
    this.answeredThisBlock.set(key, (this.answeredThisBlock.get(key) ?? 0n) + amount);
  }

  /** Margin-call USDC answered this block for an account (for landing on-chain), then cleared. */
  takeAnswered(market: string, account: string): bigint {
    const key = `${market}:${account}`;
    const v = this.answeredThisBlock.get(key) ?? 0n;
    this.answeredThisBlock.delete(key);
    return v;
  }

  /** Clear the per-block answered map (call at the start of each block). */
  beginBlock(): void {
    this.answeredThisBlock.clear();
  }

  /** Account tally (creating a zeroed one on first touch). */
  tallyOf(account: string): AccountTally {
    let t = this.tallies.get(account);
    if (!t) {
      t = { fundingNet: 0n, marginAnswered: 0n, count: 0 };
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
