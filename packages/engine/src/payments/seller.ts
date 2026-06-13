/**
 * Layer B seller side — the x402 resource the engine exposes so an agent's `GatewayClient.pay()`
 * settles a margin-call nanopayment against the venue. This is the piece Spike C left open: the
 * spike proved the buyer deposit + unified-balance precondition; here the engine is the *payee*.
 *
 * Built on Circle's `@circle-fin/x402-batching/server` `createGatewayMiddleware`, which exposes
 * framework-agnostic `verify()` / `settle()` against Circle's hosted Gateway facilitator (the TEE
 * that attests the off-chain ledger). The engine runs Hono, so it drives those two methods directly
 * from a Hono handler (`payments/routes.ts`) rather than the Express `require()` middleware:
 *
 *   1. Agent does `pay(<engine>/pay/:market)` → GatewayClient signs an EIP-3009 authorization,
 *      retries with the `Payment-Signature` header.
 *   2. The engine `verify()`s it against the facilitator (off-chain, gas-free, TEE-attested), then
 *      `settle()`s it — the agent's Gateway unified balance is debited to the engine's.
 *   3. The engine records the answered margin call in the {@link PaymentLedger}; the loop lands it
 *      on-chain via `answerMarginCall` at the next checkpoint.
 *
 * Arc Testnet is CAIP-2 `eip155:5042002`. Testnet facilitator: `https://gateway-api-testnet.circle.com`.
 *
 * @see https://developers.circle.com/gateway/nanopayments
 * @see packages/contracts/spikes/c-gateway-roundtrip.ts (the buyer side proven in Spike C)
 */

import { createGatewayMiddleware, type GatewayMiddleware } from "@circle-fin/x402-batching/server";
import { ARC } from "@sidekick/shared";
import type { Address } from "viem";

/** CAIP-2 network id for Arc testnet (the network agents pay on). */
export const ARC_CAIP2 = `eip155:${ARC.chainId}` as const;

/** Circle's hosted Gateway facilitator for testnet (verifies + settles batched payments). */
export const TESTNET_FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

/** Config for the engine's seller side. */
export interface SellerConfig {
  /** The engine operator's address — the payee that receives margin-call nanopayments. */
  sellerAddress: Address;
  /** Override the facilitator URL (defaults to the testnet facilitator). */
  facilitatorUrl?: string;
}

/** The result of attempting to settle an incoming payment. */
export interface SettleResult {
  success: boolean;
  /** Payer (agent) address recovered from the authorization. */
  payer?: string;
  /** Settlement reference (a batch/tx id) when successful. */
  transaction?: string;
  error?: string;
}

/**
 * The engine's Gateway seller. Wraps `createGatewayMiddleware` and exposes its operations to the
 * Hono routes:
 *
 *   - `require(price)` — Circle's own x402 resource middleware. This is the CORRECT way to emit the
 *     402: it fetches the facilitator's supported kinds and builds standards-compliant payment
 *     requirements (real `payTo` = the seller address, the real USDC token `asset`, and the
 *     GatewayWallet `extra.verifyingContract`) into a base64 `PAYMENT-REQUIRED` header, exactly what
 *     the buyer's `GatewayClient.pay()` reads to sign an EIP-3009 authorization. Hand-rolling the 402
 *     (placeholder `payTo`/`asset` in the body) cannot be signed against — so the route drives this
 *     middleware via a tiny Hono↔Express shim instead.
 *   - `verify` / `settle` — kept for callers that want the low-level operations directly.
 *
 * Constructing it does not open any socket; it just configures the facilitator client.
 */
export class GatewaySeller {
  private readonly mw: GatewayMiddleware;

  constructor(config: SellerConfig) {
    this.mw = createGatewayMiddleware({
      sellerAddress: config.sellerAddress,
      networks: ARC_CAIP2,
      facilitatorUrl: config.facilitatorUrl ?? TESTNET_FACILITATOR_URL,
    });
  }

  /**
   * Circle's x402 resource middleware for a given price (dollar string, e.g. `"$0.01"`). It emits the
   * facilitator-standard 402 (the `PAYMENT-REQUIRED` header with real payTo/asset/verifyingContract)
   * when unpaid, and verifies + settles when the buyer retries with a signed authorization. The route
   * runs it through a Hono↔Express shim (`payments/routes.ts`).
   */
  require(price: string): ReturnType<GatewayMiddleware["require"]> {
    return this.mw.require(price);
  }

  /** Verify a payment authorization without settling (cheap pre-check). */
  async verify(payment: unknown): Promise<{ valid: boolean; payer?: string; error?: string }> {
    return this.mw.verify(payment);
  }

  /** Settle a verified payment: debits the agent's unified balance, credits the engine's. */
  async settle(payment: unknown): Promise<SettleResult> {
    const r = await this.mw.settle(payment);
    return { success: r.success, transaction: r.transaction, error: r.error };
  }
}
