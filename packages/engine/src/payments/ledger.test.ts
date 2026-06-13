/**
 * Layer B ledger tests — the off-chain authorization record. Asserts it accumulates funding +
 * answered margin calls per account, exposes the per-block answered amount the loop lands on-chain,
 * and keeps the recent stream for the dashboard.
 */

import { describe, expect, test } from "bun:test";
import { PaymentLedger } from "./ledger.ts";

const USDC = 1_000_000n;

describe("PaymentLedger", () => {
  test("records funding cashflows and accumulates the per-account net", () => {
    const l = new PaymentLedger();
    l.recordFunding(1, "BTC-PERP", "0xA", -3n, 1000); // A pays 3 (atomic)
    l.recordFunding(1, "BTC-PERP", "0xB", 3n, 1000); // B receives 3
    l.recordFunding(2, "BTC-PERP", "0xA", -2n, 2000);
    expect(l.tallyOf("0xA").fundingNet).toBe(-5n);
    expect(l.tallyOf("0xB").fundingNet).toBe(3n);
    expect(l.totalAuthorizations).toBe(3);
  });

  test("zero-amount funding is ignored (no noise in the stream)", () => {
    const l = new PaymentLedger();
    l.recordFunding(1, "BTC-PERP", "0xA", 0n, 1000);
    expect(l.totalAuthorizations).toBe(0);
  });

  test("answered margin calls are taken once per block, then cleared", () => {
    const l = new PaymentLedger();
    l.beginBlock();
    l.recordAnsweredCall(5, "BTC-PERP", "0xA", 40n * USDC, 5000);
    l.recordAnsweredCall(5, "BTC-PERP", "0xA", 10n * USDC, 5001); // two partials same block
    expect(l.takeAnswered("BTC-PERP", "0xA")).toBe(50n * USDC); // summed
    expect(l.takeAnswered("BTC-PERP", "0xA")).toBe(0n); // consumed
    expect(l.tallyOf("0xA").marginAnswered).toBe(50n * USDC); // lifetime total persists
  });

  test("beginBlock clears the per-block answered map but not lifetime tallies", () => {
    const l = new PaymentLedger();
    l.recordAnsweredCall(1, "BTC-PERP", "0xA", 5n * USDC, 1000);
    l.beginBlock();
    expect(l.takeAnswered("BTC-PERP", "0xA")).toBe(0n); // cleared for the new block
    expect(l.tallyOf("0xA").marginAnswered).toBe(5n * USDC); // lifetime unchanged
  });

  test("pool funding accrues per market", () => {
    const l = new PaymentLedger();
    l.recordPoolFunding("BTC-PERP", 3n);
    l.recordPoolFunding("BTC-PERP", 2n);
    l.recordPoolFunding("ETH-PERP", 7n);
    expect(l.poolFundingOf("BTC-PERP")).toBe(5n);
    expect(l.poolFundingOf("ETH-PERP")).toBe(7n);
  });

  test("recent() returns the tail of the stream for the dashboard", () => {
    const l = new PaymentLedger();
    for (let i = 0; i < 100; i += 1) l.recordFunding(i, "BTC-PERP", "0xA", -1n, i);
    const recent = l.recent(10);
    expect(recent).toHaveLength(10);
    expect(recent[recent.length - 1]?.block).toBe(99); // most recent last
  });

  test("format renders a readable settlement line", () => {
    const line = PaymentLedger.format({
      block: 7,
      account: "0xB6EBC5BED5A3B3Fbb1313f03121397e0Df220A62",
      market: "BTC-PERP",
      kind: "funding",
      amount: -3_472n, // 0.003472 USDC
      at: 1000,
    });
    expect(line).toContain("funding");
    expect(line).toContain("-0.003472");
  });
});
