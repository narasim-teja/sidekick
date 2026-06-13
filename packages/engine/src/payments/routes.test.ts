/**
 * Tests for the x402 pay route (routes.ts) — specifically the Hono↔Express shim that drives Circle's
 * `require(price)` middleware. We mock the seller's `require()` to mimic the middleware's contract
 * (emit a 402 with a `PAYMENT-REQUIRED` header when unpaid; set `req.payment` + call `next()` when the
 * buyer retries with a `Payment-Signature`), and assert the route:
 *   - returns 200 `{settled:false, reason:"no-open-margin-call"}` when nothing is owed,
 *   - replays the middleware's 402 + PAYMENT-REQUIRED header verbatim when unpaid (so the buyer can
 *     sign against the real requirements — the bug that was fixed),
 *   - records the answered call in the ledger and returns `{settled:true}` on a settled retry.
 */

import { describe, expect, test } from "bun:test";
import { PaymentLedger } from "./ledger.ts";
import { paymentRoutes } from "./routes.ts";

/** A mock GatewaySeller whose `require()` reproduces Circle's middleware contract. */
function mockSeller() {
  return {
    require(_price: string) {
      // biome-ignore lint/suspicious/noExplicitAny: Express-style middleware signature.
      return async (req: any, res: any, next: (e?: unknown) => void) => {
        const sig = req.headers["payment-signature"];
        if (!sig) {
          // Unpaid: emit the standards-compliant 402 with the requirements in the header.
          res.statusCode = 402;
          res.setHeader(
            "PAYMENT-REQUIRED",
            Buffer.from(
              JSON.stringify({ x402Version: 2, accepts: [{ payTo: "0xSeller" }] }),
            ).toString("base64"),
          );
          res.end("{}");
          return;
        }
        // Signed retry: pretend verify + settle succeeded, signal via next() + req.payment.
        req.payment = {
          verified: true,
          payer: "0xPayer",
          amount: "10000",
          network: "eip155:5042002",
          transaction: "0xsettle",
        };
        next();
      };
    },
    async verify() {
      return { valid: true };
    },
    async settle() {
      return { success: true };
    },
  };
}

function makeApp(owed: bigint, ledger: PaymentLedger) {
  return paymentRoutes({
    // biome-ignore lint/suspicious/noExplicitAny: the route only uses `require` from the seller here.
    seller: mockSeller() as any,
    ledger,
    currentTick: () => 1,
    shortfall: () => owed,
  });
}

describe("paymentRoutes /pay", () => {
  test("200 no-open-margin-call when nothing is owed", async () => {
    const app = makeApp(0n, new PaymentLedger());
    const res = await app.request("/pay/BTC-PERP/0xabc", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settled: boolean; reason: string };
    expect(body.settled).toBe(false);
    expect(body.reason).toBe("no-open-margin-call");
  });

  test("402 with a PAYMENT-REQUIRED header when unpaid (the corrected 402)", async () => {
    const app = makeApp(10_000n, new PaymentLedger());
    const res = await app.request("/pay/BTC-PERP/0xabc", { method: "POST" });
    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    // The header is base64 JSON with the real requirements (a payTo address), not placeholders.
    const decoded = JSON.parse(Buffer.from(header as string, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].payTo).toBe("0xSeller");
  });

  test("settles + records the answered call when the buyer retries with a signature", async () => {
    const ledger = new PaymentLedger();
    const app = makeApp(10_000n, ledger);
    const res = await app.request("/pay/BTC-PERP/0xabc", {
      method: "POST",
      headers: { "Payment-Signature": "deadbeef" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settled: boolean; amount: string; transaction?: string };
    expect(body.settled).toBe(true);
    expect(body.amount).toBe("10000");
    expect(body.transaction).toBe("0xsettle");
    // The ledger now has a pending answered call for the loop to land on-chain.
    expect(ledger.takeAllAnswered("BTC-PERP")).toEqual([["0xabc", 10_000n]]);
  });

  test("/owed returns the current shortfall", async () => {
    const app = makeApp(42_000n, new PaymentLedger());
    const res = await app.request("/owed/BTC-PERP/0xabc");
    const body = (await res.json()) as { owed: string };
    expect(body.owed).toBe("42000");
  });
});
