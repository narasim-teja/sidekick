/**
 * MCP server tests — drive the registered tools through an in-memory client↔server pair (no stdio,
 * no network) with a faked {@link SideKick}, asserting each tool maps to the right SDK call and
 * returns a well-formed MCP result. This is the contract between an MCP client and the venue.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SideKick } from "@sidekick/sdk";
import { buildServer } from "./server.ts";

/** A fake SideKick that records calls and returns canned values — enough to exercise every tool. */
function fakeClient(): { sk: SideKick; calls: string[] } {
  const calls: string[] = [];
  const sk = {
    address: "0xAbc0000000000000000000000000000000000001",
    chainId: 5042002,
    engineUrl: "http://localhost:8787",
    async venue() {
      calls.push("venue");
      return { name: "sidekick", version: "0.3.1", markets: [{ symbol: "BTC-PERP" }] };
    },
    async getState(market: string) {
      calls.push(`getState:${market}`);
      return { market, mark: "70000", skew: 0.1 };
    },
    async getAllState() {
      calls.push("getAllState");
      return [{ market: "BTC-PERP", mark: "70000" }];
    },
    async getAccount(market: string) {
      calls.push(`getAccount:${market}`);
      return { address: "0xAbc", market, side: "long", equity: "12.5", freeCollateral: "8" };
    },
    async owed(market: string) {
      calls.push(`owed:${market}`);
      return 5_500_000n; // 5.50 USDC
    },
    async onboard(opts: unknown) {
      calls.push(`onboard:${JSON.stringify(opts)}`);
      return { address: "0xAbc", vaultDepositTx: "0xv", gatewayDepositTx: "0xg" };
    },
    async deposit(amount: string) {
      calls.push(`deposit:${amount}`);
      return "0xdep";
    },
    async withdraw(amount: string) {
      calls.push(`withdraw:${amount}`);
      return "0xwit";
    },
    async open(opts: { market: string; side: string }) {
      calls.push(`open:${opts.market}:${opts.side}`);
      return "0xopen";
    },
    async close(market: string) {
      calls.push(`close:${market}`);
      return "0xclose";
    },
    async provideLiquidity(market: string, amount: string) {
      calls.push(`lp:${market}:${amount}`);
      return "0xlp";
    },
    async answerMarginCall(market: string) {
      calls.push(`answer:${market}`);
      return { settled: true, amount: "5.50", transaction: "0xpay" };
    },
    async agentIdentity() {
      calls.push("agentIdentity");
      return {
        agentId: 42n,
        linked: true,
        agentWallet: "0xAbc0000000000000000000000000000000000001",
        namespacedId: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e/42",
      };
    },
    async recordPayment(agentId: bigint, proof: { txHash: string }) {
      calls.push(`recordPayment:${agentId}:${proof.txHash}`);
      return "0xfeedback";
    },
    async reputationSummary(agentId: bigint) {
      calls.push(`reputationSummary:${agentId}`);
      return { count: 3n, value: 3n, valueDecimals: 0 };
    },
    async confirm(_hash: string) {
      return true;
    },
  } as unknown as SideKick;
  return { sk, calls };
}

/** Spin up an in-memory MCP client connected to the server, return the connected client + call log. */
async function connect(): Promise<{ client: Client; calls: string[] }> {
  const { sk, calls } = fakeClient();
  const server = buildServer({ privateKey: "0x00", client: sk });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

/** First text-content block of a tool result, parsed back to JSON. */
function resultJson(res: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = res.content.find((c) => c.type === "text")?.text ?? "{}";
  return text.startsWith("error:") ? { error: text } : JSON.parse(text);
}

describe("SideKick MCP server", () => {
  test("lists all venue tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "sidekick_account",
        "sidekick_answer_margin_call",
        "sidekick_close",
        "sidekick_deposit",
        "sidekick_identity",
        "sidekick_onboard",
        "sidekick_open",
        "sidekick_provide_liquidity",
        "sidekick_reputation",
        "sidekick_record_payment",
        "sidekick_state",
        "sidekick_venue",
        "sidekick_whoami",
        "sidekick_withdraw",
      ].sort(),
    );
  });

  test("sidekick_venue → sk.venue()", async () => {
    const { client, calls } = await connect();
    const res = await client.callTool({ name: "sidekick_venue", arguments: {} });
    expect(calls).toContain("venue");
    expect(resultJson(res as never)).toMatchObject({ name: "sidekick" });
  });

  test("sidekick_identity → sk.agentIdentity()", async () => {
    const { client, calls } = await connect();
    const res = await client.callTool({ name: "sidekick_identity", arguments: {} });
    expect(calls).toContain("agentIdentity");
    expect(resultJson(res as never)).toMatchObject({
      linked: true,
      namespacedId: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e/42",
    });
  });

  test("sidekick_record_payment → sk.recordPayment(agentId, {txHash}) (discover→pay→record)", async () => {
    const { client, calls } = await connect();
    const res = await client.callTool({
      name: "sidekick_record_payment",
      arguments: { agentId: "42", txHash: "0xpay", market: "BTC-PERP" },
    });
    expect(calls).toContain("recordPayment:42:0xpay");
    expect(resultJson(res as never)).toMatchObject({ hash: "0xfeedback", confirmed: true });
  });

  test("sidekick_reputation → sk.reputationSummary(agentId)", async () => {
    const { client, calls } = await connect();
    const res = await client.callTool({
      name: "sidekick_reputation",
      arguments: { agentId: "42" },
    });
    expect(calls).toContain("reputationSummary:42");
    expect(resultJson(res as never)).toMatchObject({ count: "3", value: "3" });
  });

  test("sidekick_account joins position + owed shortfall", async () => {
    const { client, calls } = await connect();
    const res = await client.callTool({
      name: "sidekick_account",
      arguments: { market: "BTC-PERP" },
    });
    expect(calls).toContain("getAccount:BTC-PERP");
    expect(calls).toContain("owed:BTC-PERP");
    expect(resultJson(res as never)).toMatchObject({ side: "long", owedShortfall: "5.5" });
  });

  test("sidekick_open routes to sk.open with side", async () => {
    const { client, calls } = await connect();
    const res = await client.callTool({
      name: "sidekick_open",
      arguments: { market: "ETH-PERP", side: "short", collateral: "20", leverage: 5 },
    });
    expect(calls).toContain("open:ETH-PERP:short");
    expect(resultJson(res as never)).toMatchObject({ hash: "0xopen", confirmed: true });
  });

  test("sidekick_answer_margin_call returns the settlement", async () => {
    const { client, calls } = await connect();
    const res = await client.callTool({
      name: "sidekick_answer_margin_call",
      arguments: { market: "BTC-PERP" },
    });
    expect(calls).toContain("answer:BTC-PERP");
    expect(resultJson(res as never)).toMatchObject({ settled: true, amount: "5.50" });
  });

  test("rejects an unknown market via the schema (no SDK call)", async () => {
    const { client, calls } = await connect();
    const res = (await client.callTool({
      name: "sidekick_account",
      arguments: { market: "DOGE-PERP" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(calls.some((c) => c.startsWith("getAccount"))).toBe(false);
  });
});
