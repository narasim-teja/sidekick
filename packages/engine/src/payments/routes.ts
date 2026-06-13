/**
 * The x402 pay endpoint (Hono). This is the seller resource an agent's `GatewayClient.pay()` hits to
 * settle a margin-call nanopayment against the venue (Layer B). It is driven by **Circle's own x402
 * resource middleware** (`GatewaySeller.require(price)`) — NOT a hand-rolled 402 — so the 402 response
 * carries the facilitator-standard payment requirements (real `payTo` = seller address, the real USDC
 * token `asset`, and the GatewayWallet `extra.verifyingContract`) in a base64 `PAYMENT-REQUIRED`
 * header, which is exactly what the buyer reads to sign a valid EIP-3009 authorization. A
 * hand-built 402 with placeholder `payTo`/`asset` cannot be signed against — this route was
 * corrected to use the middleware (see the Hono↔Express shim below).
 *
 * Flow per request to `POST /pay/:market/:account`:
 *   1. Look up the account's current margin-call shortfall (the resource price). If 0, return a plain
 *      200 `{settled:false, reason:"no-open-margin-call"}` — the position is healthy, nothing owed.
 *   2. Otherwise run Circle's `require("$<shortfall>")` middleware through the shim:
 *        - no `Payment-Signature` yet  → the middleware emits the 402 + `PAYMENT-REQUIRED` header;
 *        - retry with the signed auth  → the middleware verifies + settles against Circle's testnet
 *          facilitator (off-chain, gas-free, TEE-attested) and signals success via `next()`.
 *   3. On settlement, record the answered margin call in the {@link PaymentLedger} so the loop lands
 *      it on-chain via `answerMarginCall`, and return `{settled:true, …}`.
 *
 * Sub-cent, off-chain, hundreds per block — the nanopayment economics the venue is built on.
 *
 * @see packages/engine/src/payments/seller.ts (the GatewaySeller wrapping createGatewayMiddleware)
 */

import type { MarketSymbol } from "@sidekick/shared";
import { MARKET_SYMBOLS } from "@sidekick/shared";
import { Hono } from "hono";
import { formatUsdc, parseUsdc } from "../fixed/units.ts";
import type { PaymentLedger } from "./ledger.ts";
import type { GatewaySeller } from "./seller.ts";

/** A function the engine provides: the current margin-call shortfall for (market, account), USDC 6dp. */
export type ShortfallLookup = (market: MarketSymbol, account: string) => bigint;

export interface PaymentRoutesDeps {
  seller: GatewaySeller;
  ledger: PaymentLedger;
  /** Current tick (block) for stamping the ledger entry. */
  currentTick: (market: MarketSymbol) => number;
  /** The current open margin-call shortfall for an account (the price of the resource). */
  shortfall: ShortfallLookup;
  log?: (msg: string) => void;
}

/**
 * The captured result of running an Express-style middleware: whether `next()` was called (the
 * payment verified + settled, so the resource handler should run) and, if not, the response the
 * middleware wrote (status + headers + body) to replay into the Hono response.
 */
interface ShimResult {
  nexted: boolean;
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Run Circle's Express-style `require()` middleware against a Hono request, capturing what it writes.
 * The middleware reads `req.headers["payment-signature"]`, and writes either a 402 (`PAYMENT-REQUIRED`
 * header) when unpaid or — on a verified+settled retry — sets `req.payment` and calls `next()`.
 */
async function runExpressMiddleware(
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types the middleware loosely (Express req/res).
  middleware: (req: any, res: any, next: (err?: unknown) => void) => void | Promise<void>,
  headers: Record<string, string>,
  url: string,
): Promise<ShimResult> {
  const result: ShimResult = { nexted: false, status: 200, headers: {}, body: "" };
  // Express lowercases header names; mirror that so `headers["payment-signature"]` resolves.
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;

  const req = { headers: lowered, url, method: "POST", body: undefined as unknown };
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      result.headers[name] = value;
    },
    end(chunk?: string) {
      result.status = this.statusCode;
      if (chunk !== undefined) result.body = chunk;
    },
    // Some paths use res.status(code).json(obj); support both shapes defensively.
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(obj: unknown) {
      result.status = this.statusCode;
      result.body = JSON.stringify(obj);
    },
  };

  await middleware(req, res, (_err?: unknown) => {
    result.nexted = true;
    result.payment = (req as { payment?: ShimResult["payment"] }).payment;
  });
  return result;
}

/** Build the Hono sub-app that exposes the x402 margin-call pay resource. */
export function paymentRoutes(deps: PaymentRoutesDeps): Hono {
  const app = new Hono();

  // POST /pay/:market/:account — settle a margin-call nanopayment for an account.
  app.post("/pay/:market/:account", async (c) => {
    const market = c.req.param("market") as MarketSymbol;
    const account = c.req.param("account");
    if (!MARKET_SYMBOLS.includes(market)) {
      return c.json({ error: `unknown market ${market}` }, 400);
    }

    const owed = deps.shortfall(market, account);
    if (owed <= 0n) {
      // Nothing to answer — the position is healthy. The agent can stop paying.
      return c.json({ settled: false, reason: "no-open-margin-call", owed: "0" }, 200);
    }

    // Price the resource at the shortfall (USDC decimal → dollar string for Circle's middleware).
    const price = `$${formatUsdc(owed)}`;
    const middleware = deps.seller.require(price);

    // Collect the request headers (the buyer's signed authorization arrives as `Payment-Signature`).
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.header())) headers[k] = v as string;

    const shim = await runExpressMiddleware(middleware, headers, `/pay/${market}/${account}`);

    if (!shim.nexted) {
      // The middleware wrote a 402 (or an error) — replay it verbatim so the buyer gets the real
      // PAYMENT-REQUIRED header it needs to sign against.
      for (const [name, value] of Object.entries(shim.headers)) c.header(name, value);
      const status = (shim.status || 402) as 400 | 402 | 503;
      // The 402 body is "{}" by spec (the requirements live in the header). Pass it through.
      return shim.body ? c.body(shim.body, status) : c.body("{}", status);
    }

    // Settled: record the answered call so the loop lands it on-chain via answerMarginCall.
    const paid = owed; // the buyer paid the full shortfall (the resource price)
    deps.ledger.recordAnsweredCall(deps.currentTick(market), market, account, paid, Date.now());
    deps.log?.(
      `settled margin call: ${account.slice(0, 8)}… ${market} ${shim.payment?.transaction ?? ""}`,
    );

    return c.json({
      settled: true,
      payer: shim.payment?.payer ?? account,
      transaction: shim.payment?.transaction,
      amount: paid.toString(),
    });
  });

  // A helper so an agent can read its current owed shortfall (6dp atomic) before paying.
  app.get("/owed/:market/:account", (c) => {
    const market = c.req.param("market") as MarketSymbol;
    const account = c.req.param("account");
    const owed = deps.shortfall(market, account);
    return c.json({ market, account, owed: owed.toString() });
  });

  return app;
}

/** Re-export so callers can parse a decimal price into the 6dp owed amount if they need to. */
export { parseUsdc };
