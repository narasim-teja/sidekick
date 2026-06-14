/**
 * `AgentRunner` — the autonomous shell around a {@link AgentPolicy}. This is the "small autonomous
 * loop" Doc 2 §4.1 calls for: subscribe to the per-block state, decide, act, repeat — no human in the
 * loop. It is the impure half (the policy is the pure half): it reads the agent's on-chain account,
 * runs `policy.decide`, submits the chosen action through the SDK, and answers margin calls as x402
 * Gateway nanopayments (the headline Layer B flow) — except for the dark agent, which it lets go
 * silent so the venue decrements it smoothly.
 *
 * Concurrency: actions and answers are async and a tx takes a few blocks to land. The runner serializes
 * per-agent — at most one in-flight action and one in-flight answer at a time — and skips a tick's new
 * action while one is pending, so it never double-opens or races itself. Block frames are the engine's
 * ~2s heartbeat; if the agent falls behind, it simply acts on the next frame it processes (the venue's
 * own coalescing handles staleness on the engine side).
 *
 * One runner drives one agent in one market. The orchestrator composes several; a standalone
 * `agent:*` entry runs exactly one.
 */

import type { AccountView, MarketBlockState, MarketSymbol, SideKick } from "@sidekick/sdk";
import { isDarkPolicy } from "./policies.ts";
import type { AgentAction, AgentPolicy } from "./policy.ts";

/** How the runner reports each step (for logs + the orchestrator's narration). */
export interface AgentStep {
  block: number;
  action: AgentAction;
  /** Tx hash if the action submitted a transaction. */
  tx?: string;
  /** Margin-call answer outcome this block, if any. */
  answered?: { settled: boolean; amount?: string; reason?: string };
  note?: string;
}

export interface AgentRunnerConfig {
  sk: SideKick;
  policy: AgentPolicy;
  market: MarketSymbol;
  /** Called after every processed block (logging / metrics). */
  onStep?: (step: AgentStep) => void;
  /** Logger. Defaults to a prefixed console.log. */
  log?: (msg: string) => void;
}

export class AgentRunner {
  private readonly sk: SideKick;
  private readonly policy: AgentPolicy;
  private readonly market: MarketSymbol;
  private readonly onStep?: (step: AgentStep) => void;
  private readonly log: (msg: string) => void;

  private block = 0;
  private unsub?: () => void;
  private actionInFlight = false;
  private answerInFlight = false;
  private running = false;

  constructor(cfg: AgentRunnerConfig) {
    this.sk = cfg.sk;
    this.policy = cfg.policy;
    this.market = cfg.market;
    this.onStep = cfg.onStep;
    const prefix = `[agent:${cfg.policy.id}]`;
    this.log = cfg.log ?? ((m) => console.log(`${prefix} ${m}`));
  }

  /** Subscribe to the per-block stream and start acting. Returns when {@link stop} is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log(`live on ${this.market} as ${this.sk.address} (${this.policy.kind})`);
    this.unsub = this.sk.on("block", (state) => {
      // Only react to our own market's frames.
      if (state.market !== this.market) return;
      void this.onBlock(state);
    });
  }

  /** Stop the loop and unsubscribe. */
  stop(): void {
    this.running = false;
    this.unsub?.();
    this.unsub = undefined;
  }

  /**
   * Process one block: answer a margin call if owed (unless silent), then decide + act. We answer
   * first so the position is healthy before the next decision, mirroring the §4.3 settle-then-decide
   * intent. Both are guarded against overlap.
   */
  private async onBlock(state: MarketBlockState): Promise<void> {
    const block = this.block++;
    const step: AgentStep = { block, action: { kind: "none" } };

    // 1. Answer margin calls (the x402 Gateway nanopayment) — unless this agent is (or has gone) dark.
    if (this.shouldAnswer(block) && !this.answerInFlight) {
      this.answerInFlight = true;
      try {
        const owed = await this.sk.owed(this.market);
        if (owed > 0n) {
          const res = await this.sk.answerMarginCall(this.market);
          step.answered = { settled: res.settled, amount: res.amount, reason: res.reason };
          if (res.settled)
            this.log(`answered margin call: ${res.amount} USDC (x402) ${res.transaction ?? ""}`);
        }
      } catch (err) {
        this.log(`answer failed: ${errMsg(err)}`);
      } finally {
        this.answerInFlight = false;
      }
    }

    // 2. Decide + act (skip if an action is still landing).
    if (!this.actionInFlight) {
      // Derive the account view from THIS block's frame (the engine already reconciled every position
      // and broadcast it) instead of a per-block on-chain `getAccount` — which, multiplied across the
      // fleet, saturates a free-tier RPC into read failures that stall the loop. The policies only
      // branch on `view.side`, which the frame carries exactly. See {@link viewFromFrame}.
      const view = this.viewFromFrame(state);
      const action = this.policy.decide({ view, state, block });
      step.action = action;
      if (action.kind !== "none") {
        this.actionInFlight = true;
        try {
          step.tx = await this.act(action, state);
          // Wait for the position-changing tx to MINE before clearing the in-flight guard, so by the
          // time we act again the engine's next frame reflects the new side (the engine re-reads
          // positions each block, so a mined open shows up on the following frame). Otherwise a flip
          // policy (mm / funding-strategy, which have no `opened` latch) would still see the pre-mine
          // flat row in the frame and submit a SECOND open → revert (one-position-per-market).
          if (step.tx) {
            const ok = await this.sk.confirm(step.tx as `0x${string}`);
            if (!ok) {
              this.log(`${describe(action)} tx reverted on-chain: ${step.tx}`);
              step.note = "reverted on-chain";
            } else {
              this.log(`${describe(action)} → ${step.tx}`);
            }
          }
        } catch (err) {
          this.log(`${describe(action)} reverted: ${errMsg(err)}`);
          step.note = errMsg(err);
        } finally {
          this.actionInFlight = false;
        }
      }
    }

    this.onStep?.(step);
  }

  /** Submit an action via the SDK; returns the tx hash. */
  private async act(action: AgentAction, state: MarketBlockState): Promise<string | undefined> {
    switch (action.kind) {
      case "open":
        return this.sk.open({
          market: this.market,
          side: action.side,
          collateral: action.collateral,
          leverage: action.leverage,
          mark: state.mark, // price the open at the block's mark (avoids a second oracle read)
        });
      case "close":
        return this.sk.close(this.market, state.mark);
      case "none":
        return undefined;
    }
  }

  /** Whether to answer this block: the policy's flag, but the dark agent's time-gated `isDark`. */
  private shouldAnswer(block: number): boolean {
    if (isDarkPolicy(this.policy)) return !this.policy.isDark(block);
    return this.policy.answersMarginCalls;
  }

  /**
   * Build this agent's {@link AccountView} from the block frame the engine already broadcast — no
   * on-chain read. The engine reconciles every open position each block and includes it in
   * `state.positions`, so the agent's own row (matched by address) carries everything the policies
   * consult. A missing row means the agent holds no position this block → flat.
   *
   * `freeCollateral` is not part of the frame (it's a Vault balance, not a per-position field) and no
   * policy reads it, so it is reported as "0" here. If a future policy needs it, read it on-chain on
   * demand (sparingly) rather than reviving a per-block `getAccount` for the whole fleet.
   */
  private viewFromFrame(state: MarketBlockState): AccountView {
    const me = this.sk.address.toLowerCase();
    const pos = state.positions.find((p) => p.account.toLowerCase() === me);
    if (!pos) {
      return {
        address: this.sk.address,
        market: this.market,
        side: "flat",
        entryNotional: "0",
        entryMark: state.mark,
        margin: "0",
        equity: "0",
        freeCollateral: "0",
      };
    }
    return {
      address: this.sk.address,
      market: this.market,
      side: pos.side,
      entryNotional: pos.notionalAfter,
      entryMark: state.mark,
      margin: "0", // not in the frame; unused by policies
      equity: pos.equity,
      freeCollateral: "0", // not in the frame; unused by policies
    };
  }
}

function describe(a: AgentAction): string {
  if (a.kind === "open") return `open ${a.side} ${a.collateral}@${a.leverage}x`;
  if (a.kind === "close") return "close";
  return "hold";
}

function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // viem errors are verbose; keep the first line for readable logs.
  return m.split("\n")[0] ?? m;
}
