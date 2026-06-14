/**
 * Integration test for the autonomous loop (runner.ts) against a MOCK SideKick — no chain, no engine.
 * It proves the wiring the demo depends on: the runner reacts to per-block frames, runs the policy and
 * submits its action, answers margin calls via the SDK when owed, and — critically — the dark agent
 * stops answering once it goes silent (the no-liquidation proof). We drive synthetic `block` frames
 * and assert the SDK calls the runner made.
 *
 * The mock implements only the SideKick surface the runner touches; we cast it to the type at the
 * boundary so the test exercises the real runner unchanged.
 */

import { describe, expect, test } from "bun:test";
import type { AccountView, MarketBlockState, SideKick } from "@sidekick/sdk";
import { darkPolicy, directionalPolicy } from "./policies.ts";
import { AgentRunner } from "./runner.ts";

/** A controllable mock SideKick: feed it block frames, inspect what the runner called. */
class MockSideKick {
  readonly address = "0x00000000000000000000000000000000000000aa" as const;
  readonly engineUrl = "http://mock";
  private handler?: (s: MarketBlockState) => void;

  // What the runner reads back:
  owedAmount = 0n;
  side: "flat" | "long" | "short" = "flat";

  // Recorded calls:
  opens: Array<{ side: string; collateral: string; leverage: number }> = [];
  closes = 0;
  answers = 0;

  on(_event: "block", handler: (s: MarketBlockState) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  /** Push a block frame to the runner and let its async handler settle. */
  async emit(state: MarketBlockState): Promise<void> {
    this.handler?.(state);
    // Let the runner's async onBlock chain (owed → answer → getAccount → act) flush.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  async owed(): Promise<bigint> {
    return this.owedAmount;
  }

  async answerMarginCall(): Promise<{ settled: boolean; amount?: string }> {
    this.answers++;
    this.owedAmount = 0n; // a successful answer clears the shortfall
    return { settled: true, amount: "0.01" };
  }

  // NOTE: the runner no longer calls getAccount per block (it derives the view from the WS frame's
  // positions to avoid saturating the RPC). Kept only to satisfy the SideKick shape; the runner's
  // view of `side` now comes from what `emit`'d frames carry in `positions` — see `frame(tick, side)`.
  async getAccount(): Promise<AccountView> {
    return {
      address: this.address,
      market: "BTC-PERP",
      side: this.side,
      entryNotional: "0",
      entryMark: "0",
      margin: "0",
      equity: "0",
      freeCollateral: "100",
    };
  }

  async open(opts: {
    side: "long" | "short";
    collateral: string;
    leverage: number;
  }): Promise<string> {
    this.opens.push({ side: opts.side, collateral: opts.collateral, leverage: opts.leverage });
    this.side = opts.side; // reflect the new position (the test's next frame should carry it)
    return "0xopen";
  }

  async close(): Promise<string> {
    this.closes++;
    this.side = "flat";
    return "0xclose";
  }

  // The runner waits for position-changing txs to mine before clearing its in-flight guard.
  async confirm(_hash: string): Promise<boolean> {
    return true;
  }

  disconnect(): void {}
}

const AGENT_ADDR = "0x00000000000000000000000000000000000000aa";

/** A block frame; pass `side` to include the agent's own position (how the runner now reads its side). */
function frame(tick: number, side: "long" | "short" | "flat" = "flat"): MarketBlockState {
  const positions =
    side === "flat"
      ? []
      : [
          {
            account: AGENT_ADDR,
            side,
            notionalBefore: "16",
            notionalAfter: "16",
            equity: "4",
            funding: "0",
            call: "0",
            paid: "0",
            outcome: "healthy" as const,
          },
        ];
  return {
    market: "BTC-PERP",
    tick,
    arcBlock: tick,
    mark: "70000",
    markProvenance: "synthetic-fallback",
    skew: 0,
    smoothSkew: 0,
    fundingRate: 0,
    oiLong: "0",
    oiShort: "0",
    positions,
    pool: {
      capital: "100",
      gapFund: "0",
      exposure: "0",
      cap: "300",
      equity: "100",
      fundingAccrued: "0",
    },
    settlement: [],
    at: 0,
  };
}

describe("AgentRunner", () => {
  test("opens once on the policy's decision and then holds", async () => {
    const mock = new MockSideKick();
    const runner = new AgentRunner({
      sk: mock as unknown as SideKick,
      policy: directionalPolicy({
        id: "long",
        side: "long",
        collateral: "4",
        leverage: 4,
        openAt: 0,
      }),
      market: "BTC-PERP",
    });
    runner.start();
    await mock.emit(frame(1)); // flat → opens long
    // Subsequent frames now CARRY the agent's position (as the real engine would), so the runner sees
    // itself as non-flat from the frame and holds — proving it reads side from the frame, not getAccount.
    await mock.emit(frame(2, "long"));
    await mock.emit(frame(3, "long"));
    runner.stop();
    expect(mock.opens).toEqual([{ side: "long", collateral: "4", leverage: 4 }]);
    expect(mock.closes).toBe(0);
  });

  test("derives its side from the frame's positions (no per-block getAccount)", async () => {
    const mock = new MockSideKick();
    let getAccountCalls = 0;
    // Spy: the runner must NOT call getAccount in the per-block decide path anymore.
    mock.getAccount = async () => {
      getAccountCalls++;
      return {
        address: mock.address,
        market: "BTC-PERP",
        side: "flat",
        entryNotional: "0",
        entryMark: "0",
        margin: "0",
        equity: "0",
        freeCollateral: "100",
      };
    };
    const runner = new AgentRunner({
      sk: mock as unknown as SideKick,
      policy: directionalPolicy({
        id: "long",
        side: "long",
        collateral: "4",
        leverage: 4,
        openAt: 0,
      }),
      market: "BTC-PERP",
    });
    runner.start();
    // The very first frame already reports the agent holding a long → the open-once policy must NOT
    // open (it sees itself non-flat purely from the frame).
    await mock.emit(frame(1, "long"));
    runner.stop();
    expect(mock.opens).toHaveLength(0);
    expect(getAccountCalls).toBe(0); // the RPC-heavy read is gone from the hot path
  });

  test("answers a margin call via the SDK when owed", async () => {
    const mock = new MockSideKick();
    mock.owedAmount = 10_000n; // 0.01 USDC owed
    const runner = new AgentRunner({
      sk: mock as unknown as SideKick,
      policy: directionalPolicy({
        id: "long",
        side: "long",
        collateral: "4",
        leverage: 4,
        openAt: 99,
      }),
      market: "BTC-PERP",
    });
    runner.start();
    await mock.emit(frame(1));
    runner.stop();
    expect(mock.answers).toBe(1);
  });

  test("ignores frames for other markets", async () => {
    const mock = new MockSideKick();
    const runner = new AgentRunner({
      sk: mock as unknown as SideKick,
      policy: directionalPolicy({
        id: "long",
        side: "long",
        collateral: "4",
        leverage: 4,
        openAt: 0,
      }),
      market: "ETH-PERP", // runner is on ETH; frames are BTC
    });
    runner.start();
    await mock.emit(frame(1));
    runner.stop();
    expect(mock.opens).toHaveLength(0);
  });

  test("the dark agent stops answering once it goes silent", async () => {
    const mock = new MockSideKick();
    mock.owedAmount = 10_000n;
    const runner = new AgentRunner({
      sk: mock as unknown as SideKick,
      // opens at 0, goes dark at block 2.
      policy: darkPolicy({ id: "dark", collateral: "1", leverage: 20, openAt: 0, goesDarkAt: 2 }),
      market: "BTC-PERP",
    });
    runner.start();
    // block 0: alive, answers (owed cleared); block 1: alive; block 2+: dark, must NOT answer.
    await mock.emit(frame(1)); // runner block 0 → answers, clears owed
    mock.owedAmount = 10_000n; // owe again
    await mock.emit(frame(2)); // runner block 1 → still alive → answers, clears owed
    mock.owedAmount = 10_000n; // owe again
    await mock.emit(frame(3)); // runner block 2 → DARK → must not answer
    await mock.emit(frame(4)); // runner block 3 → DARK → must not answer
    runner.stop();
    expect(mock.answers).toBe(2); // only the two pre-dark blocks answered
    expect(mock.owedAmount).toBe(10_000n); // still owed (it went silent → would decrement on-chain)
  });
});
