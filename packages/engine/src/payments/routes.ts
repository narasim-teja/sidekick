/**
 * The x402 pay endpoint (Hono). This is the seller resource an agent's `GatewayClient.pay()` hits
 * to settle a margin-call nanopayment against the venue (Layer B). The flow follows the x402
 * protocol over HTTP 402:
 *
 *   - First request (no `Payment-Signature`): respond 402 with the payment requirements, so the
 *     agent's GatewayClient knows where + how much to pay and signs an EIP-3009 authorization.
 *   - Retry (with the signed authorization): verify + settle it against Circle's Gateway
 *     facilitator (off-chain, gas-free, TEE-attested), then record the answered margin call in the
 *     {@link PaymentLedger} so the loop lands it on-chain via `answerMarginCall`.
 *
 * The amount is the agent's current margin-call shortfall for that market (the engine knows it from
 * the last reconcile); the agent pays toward it. Sub-cent, off-chain, hundreds per block — exactly
 * the nanopayment economics the venue is built on.
 *
 * @see packages/engine/src/payments/seller.ts (verify/settle) · /ledger.ts (the off-chain record)
 */

import type { MarketSymbol } from "@sidekick/shared";
import { MARKET_SYMBOLS } from "@sidekick/shared";
import { Hono } from "hono";
import { parseUsdc } from "../fixed/units.ts";
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

const PAYMENT_HEADER = "payment-signature";

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

    const sig = c.req.header(PAYMENT_HEADER);
    if (!sig) {
      // x402: no authorization yet — tell the agent the price (its shortfall) so it can sign.
      return c.json(
        {
          x402Version: 1,
          error: "payment required",
          accepts: [
            {
              scheme: "exact",
              network: `eip155:${5042002}`,
              asset: "USDC",
              amount: owed.toString(), // 6dp atomic
              payTo: "engine-operator", // the seller address is configured on the facilitator side
              maxTimeoutSeconds: 60,
              resource: `/pay/${market}/${account}`,
            },
          ],
        },
        402,
      );
    }

    // The agent retried with a signed authorization. Parse it and verify + settle.
    let payment: unknown;
    try {
      payment = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
    } catch {
      return c.json({ error: "malformed Payment-Signature (expected base64 JSON)" }, 400);
    }

    const verified = await deps.seller.verify(payment);
    if (!verified.valid) {
      return c.json({ settled: false, error: verified.error ?? "verification failed" }, 402);
    }

    const settled = await deps.seller.settle(payment);
    if (!settled.success) {
      return c.json({ settled: false, error: settled.error ?? "settlement failed" }, 402);
    }

    // Record the answered call so the loop lands it on-chain via answerMarginCall.
    const paid = owed; // the agent paid toward the full shortfall (the resource price)
    deps.ledger.recordAnsweredCall(deps.currentTick(market), market, account, paid, Date.now());
    deps.log?.(
      `settled margin call: ${account.slice(0, 8)}… ${market} ${settled.transaction ?? ""}`,
    );

    return c.json({
      settled: true,
      payer: verified.payer ?? settled.payer,
      transaction: settled.transaction,
      amount: paid.toString(),
    });
  });

  // A tiny helper so an agent can pre-deposit/seed via a decimal amount in tests.
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
