/**
 * AccountTracker — the engine must pass `checkpoint(marketId, mark, accounts)` the set of accounts
 * with an open position. The contract is the source of truth (it skips flats defensively), but the
 * engine has to enumerate candidates off-chain. We derive that set from `PositionOpened` /
 * `PositionClosed` events: backfill from a start block on startup, then keep it current by polling
 * new logs each block. A close removes the account; a (re-)open adds it.
 *
 * Tracking per market keeps each checkpoint's account list tight (only that market's traders).
 *
 * @see packages/contracts/src/PerpEngine.sol (the events)
 */

import type { MarketSymbol } from "@sidekick/shared";
import { marketId as marketIdOf } from "@sidekick/shared";
import type { Address, Hex, PublicClient } from "viem";
import { getAddress, parseAbiItem } from "viem";

const OPENED = parseAbiItem(
  "event PositionOpened(bytes32 indexed marketId, address indexed account, uint8 side, uint256 notional, uint256 margin, uint256 mark)",
);
const CLOSED = parseAbiItem(
  "event PositionClosed(bytes32 indexed marketId, address indexed account, int256 realizedPnl, uint256 mark)",
);

/** Tracks the open-position account set per market by following the engine's events. */
export class AccountTracker {
  /** symbol → set of accounts believed to have an open position. */
  private readonly open = new Map<MarketSymbol, Set<Address>>();
  private lastScanned: bigint;
  /** Max block span per `eth_getLogs` call — many free-tier RPCs cap this (Alchemy: 10). */
  private readonly chunkSize: bigint;

  constructor(
    private readonly pub: PublicClient,
    private readonly perpEngine: Address,
    private readonly symbols: MarketSymbol[],
    fromBlock: bigint,
    chunkSize = 10n,
  ) {
    for (const s of symbols) this.open.set(s, new Set());
    // Start one before so the first sync includes `fromBlock`.
    this.lastScanned = fromBlock > 0n ? fromBlock - 1n : 0n;
    this.chunkSize = chunkSize > 0n ? chunkSize : 10n;
  }

  /** Backfill from the start block to head, then the tracker is current. Call once on startup. */
  async backfill(): Promise<void> {
    const head = await this.pub.getBlockNumber();
    await this.scanTo(head);
  }

  /**
   * Bring the tracker up to `toBlock` (defaults to chain head), applying any open/close events in
   * the new range. Idempotent and cheap when there are no new logs. Call each block before reading
   * {@link accounts}.
   */
  async sync(toBlock?: bigint): Promise<void> {
    const head = toBlock ?? (await this.pub.getBlockNumber());
    if (head <= this.lastScanned) return;
    await this.scanTo(head);
  }

  private async scanTo(head: bigint): Promise<void> {
    let from = this.lastScanned + 1n;
    if (from > head) {
      this.lastScanned = head;
      return;
    }
    // Chunk into `chunkSize`-block windows so a capped RPC (free-tier Alchemy = 10 blocks) is happy
    // and a large backfill range doesn't blow up a single request.
    while (from <= head) {
      const to = from + this.chunkSize - 1n > head ? head : from + this.chunkSize - 1n;
      await this.scanRange(from, to);
      this.lastScanned = to;
      from = to + 1n;
    }
  }

  /** Scan a single bounded [from, to] range and apply its open/close events. */
  private async scanRange(from: bigint, to: bigint): Promise<void> {
    const [opened, closed] = await Promise.all([
      this.pub.getLogs({ address: this.perpEngine, event: OPENED, fromBlock: from, toBlock: to }),
      this.pub.getLogs({ address: this.perpEngine, event: CLOSED, fromBlock: from, toBlock: to }),
    ]);
    // Apply in block/log order so an open-then-close in the same range nets correctly.
    const events = [
      ...opened.map((l) => ({ kind: "open" as const, log: l })),
      ...closed.map((l) => ({ kind: "close" as const, log: l })),
    ].sort((a, b) => {
      const bn = Number((a.log.blockNumber ?? 0n) - (b.log.blockNumber ?? 0n));
      return bn !== 0 ? bn : Number((a.log.logIndex ?? 0) - (b.log.logIndex ?? 0));
    });
    for (const { kind, log } of events) {
      const mid = log.args.marketId as Hex;
      const account = log.args.account as Address;
      const symbol = this.symbolFor(mid);
      if (!symbol) continue;
      const set = this.open.get(symbol);
      if (!set) continue;
      if (kind === "open") set.add(getAddress(account));
      else set.delete(getAddress(account));
    }
  }

  /** The accounts believed to hold an open position in `symbol` (checkpoint candidate list). */
  accounts(symbol: MarketSymbol): Address[] {
    return [...(this.open.get(symbol) ?? [])];
  }

  /** Manually note an open (e.g. right after the engine itself opens a position in a test/demo). */
  noteOpen(symbol: MarketSymbol, account: Address): void {
    this.open.get(symbol)?.add(getAddress(account));
  }

  /** Map an on-chain marketId back to its symbol (only the tracked ones). */
  private symbolFor(mid: Hex): MarketSymbol | undefined {
    return this.symbols.find((s) => (marketIdOf(s) as Hex).toLowerCase() === mid.toLowerCase());
  }
}
