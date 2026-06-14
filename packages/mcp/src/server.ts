/**
 * @sidekick/mcp — the SideKick venue as an MCP server.
 *
 * This is the literal "agent-native" surface: every capability of {@link SideKick} is exposed as an
 * MCP tool, so any MCP client (Claude Desktop, the Claude API agent loop, an IDE) can **discover**
 * the venue, **onboard**, **trade**, **read** live state, and **answer margin calls** — purely by
 * calling tools, with no SDK code of its own. It's a thin adapter: each tool builds the right
 * `SideKick` call, runs it, and returns a compact JSON text result the model can reason over.
 *
 * One account per server process. The signer is resolved in {@link main} (index.ts): a **Circle
 * developer-controlled wallet** (`CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` + `CIRCLE_WALLET_ID` — MPC
 * custody, no raw key in the process). There is no raw-key env fallback. The engine URL comes from
 * `ENGINE_URL` (default `http://localhost:8787`). Keep secrets in the MCP client's env, never in tool
 * args.
 *
 * @see ../../sdk/src/client.ts (the wrapped surface) · ../../../AGENTS.md (the agent reference)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MARKET_SYMBOLS, type MarketSymbol, SideKick } from "@sidekick/sdk";
import { z } from "zod";

export const MCP_VERSION = "0.1.0" as const;

/**
 * Config for {@link buildServer}: the constructed {@link SideKick} client to serve. In production
 * `main` (index.ts) injects a Circle-backed `client`. buildServer stays sync + signer-agnostic so it's
 * trivially testable with an injected client. The raw `privateKey` form is a **test/convenience seam
 * only** (it leans on the SDK's generic signer) — it is NOT wired to any env var; the MCP server has no
 * raw-key env fallback.
 */
export interface McpConfig {
  /** A pre-built client (Circle-backed in production) — the normal path. */
  client?: SideKick;
  /** Test/convenience only: a raw private key the SDK builds a client from (if `client` is absent). */
  privateKey?: `0x${string}`;
  /** The engine REST/WS base URL (only used with `privateKey`). Defaults to `http://localhost:8787`. */
  engineUrl?: string;
}

/** A market-symbol zod enum built from the shared market list, so the tool schema can't drift. */
const marketEnum = z.enum(MARKET_SYMBOLS as [MarketSymbol, ...MarketSymbol[]]);

/** Wrap a value as the MCP text-content result the model reads (compact JSON, pretty-printed). */
function ok(value: unknown): { content: [{ type: "text"; text: string }] } {
  // The SDK returns on-chain quantities as bigint (e.g. ERC-8004 agentId, owed amounts); JSON.stringify
  // can't serialize BigInt, so coerce them to strings at the boundary the model reads.
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return { content: [{ type: "text", text }] };
}

/** Wrap an error as an MCP tool error result (so the model sees the failure, not a thrown exception). */
function fail(err: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

/**
 * Build the SideKick MCP server with every venue tool registered. Exposed (not just `main`) so tests
 * can construct it with an injected client and exercise the tools without a transport.
 */
export function buildServer(config: McpConfig): McpServer {
  let sk = config.client;
  if (!sk) {
    if (!config.privateKey) {
      throw new Error("buildServer requires either `client` or `privateKey`");
    }
    sk = new SideKick({
      network: "arc-testnet",
      privateKey: config.privateKey,
      engineUrl: config.engineUrl,
    });
  }

  const server = new McpServer({ name: "sidekick", version: MCP_VERSION });

  // ── Discover ────────────────────────────────────────────────────────────────────
  server.registerTool(
    "sidekick_venue",
    {
      title: "Describe the SideKick venue",
      description:
        "Self-describe the venue with zero prior knowledge: live markets and their params " +
        "(m, alpha, lambda, rMax, k), on-chain contract addresses, oracle source per market, block/" +
        "checkpoint/funding cadence, the units convention, and a live headline snapshot (mark, skew, " +
        "funding rate, open interest, pool capital) per market. Call this first to decide what to trade.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return ok(await sk.venue());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sidekick_whoami",
    {
      title: "This agent's address",
      description: "Return the trading account's address and the chain it is configured for.",
      inputSchema: z.object({}),
    },
    async () => ok({ address: sk.address, chainId: sk.chainId, engineUrl: sk.engineUrl }),
  );

  server.registerTool(
    "sidekick_identity",
    {
      title: "This agent's ERC-8004 identity",
      description:
        "Resolve this agent's on-chain ERC-8004 (Trustless Agents) identity: the linked agentId " +
        "(0 if unregistered), the canonical payee agentWallet, and the portable namespaced id " +
        "`eip155:<chainId>:<registry>/<agentId>` an external system uses to look up reputation. " +
        "An unregistered agent can mint one with `sidekick_onboard` (registerIdentity).",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return ok(await sk.agentIdentity());
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Read live state ───────────────────────────────────────────────────────────────
  server.registerTool(
    "sidekick_state",
    {
      title: "Live market state",
      description:
        "The latest per-block state for one market (or all markets if `market` is omitted): mark, " +
        "skew, smoothSkew, funding rate, open interest, every open position, pool health, and the " +
        "recent settlement-flow stream. All amounts are decimal strings (USDC).",
      inputSchema: z.object({
        market: marketEnum
          .optional()
          .describe("Market symbol, e.g. BTC-PERP. Omit for all markets."),
      }),
    },
    async ({ market }) => {
      try {
        if (market) {
          const s = await sk.getState(market);
          return s ? ok(s) : ok({ market, state: null, note: "no state produced yet" });
        }
        return ok(await sk.getAllState());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sidekick_account",
    {
      title: "My account in a market",
      description:
        "This agent's joined view in a market at the live mark: side, entry notional, entry mark, " +
        "posted margin, equity, and free collateral (all decimal USDC). Also reports any currently " +
        "owed margin-call shortfall.",
      inputSchema: z.object({ market: marketEnum.describe("Market symbol, e.g. BTC-PERP.") }),
    },
    async ({ market }) => {
      try {
        const [view, owed] = await Promise.all([sk.getAccount(market), sk.owed(market)]);
        return ok({ ...view, owedShortfall: (Number(owed) / 1e6).toString() });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Onboard + collateral ────────────────────────────────────────────────────────
  server.registerTool(
    "sidekick_onboard",
    {
      title: "Onboard this account",
      description:
        "Deposit trading collateral into the Vault and/or a balance into the Circle Gateway (the " +
        "off-chain balance margin-call nanopayments draw against). Both amounts optional; each step " +
        "is skipped if absent. Amounts are decimal USDC strings.",
      inputSchema: z.object({
        depositUSDC: z.string().optional().describe("USDC into the Vault as trading collateral."),
        gatewayUSDC: z.string().optional().describe("USDC into the Circle Gateway balance."),
      }),
    },
    async ({ depositUSDC, gatewayUSDC }) => {
      try {
        const res = await sk.onboard({ depositUSDC, gatewayUSDC });
        return ok(res);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sidekick_deposit",
    {
      title: "Deposit collateral",
      description: "Deposit USDC from the wallet into the Vault as free trading collateral.",
      inputSchema: z.object({ amount: z.string().describe('Decimal USDC, e.g. "50".') }),
    },
    async ({ amount }) => {
      try {
        const hash = await sk.deposit(amount);
        return ok({ hash, confirmed: await sk.confirm(hash) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sidekick_withdraw",
    {
      title: "Withdraw collateral",
      description: "Withdraw un-utilized (free) collateral from the Vault back to the wallet.",
      inputSchema: z.object({ amount: z.string().describe("Decimal USDC.") }),
    },
    async ({ amount }) => {
      try {
        const hash = await sk.withdraw(amount);
        return ok({ hash, confirmed: await sk.confirm(hash) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Trade ──────────────────────────────────────────────────────────────────────
  server.registerTool(
    "sidekick_open",
    {
      title: "Open a position",
      description:
        "Open a position in a market (one position per market — close to flip side or resize). " +
        "Size by `leverage` (notional = collateral × leverage) OR explicit `notional`, not both. " +
        "Omit `mark` to price at the live on-chain mark. Requires enough free collateral.",
      inputSchema: z.object({
        market: marketEnum.describe("Market symbol, e.g. BTC-PERP."),
        side: z.enum(["long", "short"]).describe("Position side."),
        collateral: z.string().describe('Margin to post, decimal USDC, e.g. "20".'),
        leverage: z
          .number()
          .positive()
          .optional()
          .describe("Leverage sugar; mutually exclusive with notional."),
        notional: z
          .string()
          .optional()
          .describe("Explicit notional, decimal USDC; mutually exclusive with leverage."),
        mark: z.string().optional().describe("Mark to price at; omit for the live mark."),
      }),
    },
    async ({ market, side, collateral, leverage, notional, mark }) => {
      try {
        const hash = await sk.open({ market, side, collateral, leverage, notional, mark });
        return ok({ hash, confirmed: await sk.confirm(hash), market, side, collateral });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sidekick_close",
    {
      title: "Close a position",
      description:
        "Close this account's position in a market at the live (or supplied) mark, realizing PnL " +
        "back to free collateral.",
      inputSchema: z.object({
        market: marketEnum.describe("Market symbol."),
        mark: z.string().optional().describe("Mark to close at; omit for the live mark."),
      }),
    },
    async ({ market, mark }) => {
      try {
        const hash = await sk.close(market, mark);
        return ok({ hash, confirmed: await sk.confirm(hash), market });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Liquidity ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "sidekick_provide_liquidity",
    {
      title: "Provide liquidity",
      description:
        "Provide liquidity to a market's pool from free collateral; mints slpUSDC shares.",
      inputSchema: z.object({
        market: marketEnum.describe("Market symbol."),
        amount: z.string().describe("Decimal USDC to provide."),
      }),
    },
    async ({ market, amount }) => {
      try {
        const hash = await sk.provideLiquidity(market, amount);
        return ok({ hash, confirmed: await sk.confirm(hash), market, amount });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Settle (the headline gas-free flow) ──────────────────────────────────────────
  server.registerTool(
    "sidekick_answer_margin_call",
    {
      title: "Answer a margin call (gas-free)",
      description:
        "Answer this account's open margin call in a market as a gas-free Circle Gateway x402 " +
        "nanopayment. Returns the settlement result. If the position is already healthy it returns " +
        'settled:false with reason:"no-open-margin-call" (not an error). Requires a funded Gateway ' +
        "balance (onboard with gatewayUSDC). NOTE: missing a call is safe — the venue decrements your " +
        "position smoothly instead of liquidating it.",
      inputSchema: z.object({ market: marketEnum.describe("Market symbol.") }),
    },
    async ({ market }) => {
      try {
        return ok(await sk.answerMarginCall(market));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Record (the ERC-8004 reputation leg — closes discover→pay→record) ─────────────
  server.registerTool(
    "sidekick_record_payment",
    {
      title: "Record a settled payment as ERC-8004 reputation",
      description:
        "Record a settled margin-call Nanopayment as on-chain ERC-8004 reputation feedback for an " +
        "agent (the 'record' leg of the agentic loop). Anchors keccak256(txHash) as proof-of-payment " +
        "in the Reputation Registry. Costs USDC gas. The venue is the natural attester.",
      inputSchema: z.object({
        agentId: z.string().describe("The ERC-8004 agentId to credit (decimal string)."),
        txHash: z.string().describe("The settle transaction hash to anchor as proof-of-payment."),
        market: marketEnum.optional().describe("Market the payment was for (tags the feedback)."),
      }),
    },
    async ({ agentId, txHash, market }) => {
      try {
        const hash = await sk.recordPayment(BigInt(agentId), {
          txHash: txHash as `0x${string}`,
          market,
        });
        return ok({ hash, confirmed: await sk.confirm(hash) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sidekick_reputation",
    {
      title: "An agent's ERC-8004 reputation summary",
      description:
        "Read an agent's running ERC-8004 reputation: the feedback count + aggregate value from the " +
        "Reputation Registry. Resolve 'how trustworthy is this agent' before transacting.",
      inputSchema: z.object({
        agentId: z.string().describe("The ERC-8004 agentId (decimal string)."),
      }),
    },
    async ({ agentId }) => {
      try {
        return ok(await sk.reputationSummary(BigInt(agentId)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
