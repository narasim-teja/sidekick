/**
 * Tests for the five agent policies (policies.ts) — the behavioral core of Phase 4. Each policy is a
 * pure function of (account view, market state, block), so we can assert its decisions over crafted
 * contexts without any chain/SDK. These pin the archetype behaviours Doc 3 §11 demos depend on:
 *
 *   - long/short  — open once at the staged block, then hold (never re-open).
 *   - mm          — take the minority (balancing) side; flip when the crowd flips past the deadband.
 *   - funding     — ride the funding-RECEIVING side; flip when the funding rate changes sign.
 *   - dark        — open once, then report `isDark` true after going silent.
 */

import { describe, expect, test } from "bun:test";
import type { AccountView, MarketBlockState } from "@sidekick/sdk";
import {
  darkPolicy,
  directionalPolicy,
  fundingStrategyPolicy,
  isDarkPolicy,
  mmPolicy,
} from "./policies.ts";
import type { PolicyCtx } from "./policy.ts";

/** Build a minimal AccountView with a given side (other fields are placeholders the policies ignore). */
function view(side: "flat" | "long" | "short"): AccountView {
  return {
    address: "0x0000000000000000000000000000000000000001",
    market: "BTC-PERP",
    side,
    entryNotional: "0",
    entryMark: "0",
    margin: "0",
    equity: "0",
    freeCollateral: "100",
  };
}

/** Build a minimal MarketBlockState with the fields the policies read (skew, fundingRate). */
function state(opts: { skew?: number; fundingRate?: number } = {}): MarketBlockState {
  return {
    market: "BTC-PERP",
    tick: 1,
    arcBlock: 1,
    mark: "70000",
    markProvenance: "synthetic-fallback",
    skew: opts.skew ?? 0,
    smoothSkew: opts.skew ?? 0,
    fundingRate: opts.fundingRate ?? 0,
    oiLong: "0",
    oiShort: "0",
    positions: [],
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

function ctx(v: AccountView, s: MarketBlockState, block: number): PolicyCtx {
  return { view: v, state: s, block };
}

describe("directionalPolicy", () => {
  test("opens once at openAt with the configured side/size, then holds", () => {
    const p = directionalPolicy({
      id: "long",
      side: "long",
      collateral: "4",
      leverage: 4,
      openAt: 2,
    });
    // Before openAt: hold.
    expect(p.decide(ctx(view("flat"), state(), 0)).kind).toBe("none");
    expect(p.decide(ctx(view("flat"), state(), 1)).kind).toBe("none");
    // At openAt: open long.
    const open = p.decide(ctx(view("flat"), state(), 2));
    expect(open).toEqual({ kind: "open", side: "long", collateral: "4", leverage: 4 });
    // Once positioned: hold (never re-open).
    expect(p.decide(ctx(view("long"), state(), 3)).kind).toBe("none");
  });

  test("does not re-open after it has opened once, even if it goes flat", () => {
    const p = directionalPolicy({
      id: "x",
      side: "short",
      collateral: "2",
      leverage: 2,
      openAt: 0,
    });
    expect(p.decide(ctx(view("flat"), state(), 0)).kind).toBe("open");
    // It opened; if it later reads flat (e.g. closed by decrement), it does NOT auto-reopen.
    expect(p.decide(ctx(view("flat"), state(), 5)).kind).toBe("none");
  });

  test("answers margin calls", () => {
    expect(
      directionalPolicy({ id: "l", side: "long", collateral: "1", leverage: 1 }).answersMarginCalls,
    ).toBe(true);
  });
});

describe("mmPolicy — takes the balancing (minority) side", () => {
  test("does nothing before arriveAt", () => {
    const p = mmPolicy({ collateral: "3", leverage: 3, arriveAt: 5 });
    expect(p.decide(ctx(view("flat"), state({ skew: 0.5 }), 4)).kind).toBe("none");
  });

  test("opens SHORT when the book is net long (skew > 0)", () => {
    const p = mmPolicy({ collateral: "3", leverage: 3, arriveAt: 0 });
    const a = p.decide(ctx(view("flat"), state({ skew: 0.4 }), 0));
    expect(a).toMatchObject({ kind: "open", side: "short" });
  });

  test("opens LONG when the book is net short (skew < 0)", () => {
    const p = mmPolicy({ collateral: "3", leverage: 3, arriveAt: 0 });
    const a = p.decide(ctx(view("flat"), state({ skew: -0.4 }), 0));
    expect(a).toMatchObject({ kind: "open", side: "long" });
  });

  test("flips (closes) when the crowd flips past the deadband", () => {
    const p = mmPolicy({ collateral: "3", leverage: 3, arriveAt: 0, deadband: 0.05 });
    // It is short, but the book is now net SHORT (skew < 0) past the deadband → it should de-risk.
    expect(p.decide(ctx(view("short"), state({ skew: -0.2 }), 1)).kind).toBe("close");
  });

  test("holds inside the deadband (no churn near balance)", () => {
    const p = mmPolicy({ collateral: "3", leverage: 3, arriveAt: 0, deadband: 0.1 });
    // Short, book mildly net short but within the deadband → hold (don't thrash).
    expect(p.decide(ctx(view("short"), state({ skew: -0.05 }), 1)).kind).toBe("none");
  });
});

describe("fundingStrategyPolicy — rides the funding-receiving side", () => {
  test("opens SHORT when rate ≥ 0 (longs pay, shorts receive)", () => {
    const p = fundingStrategyPolicy({ collateral: "3", leverage: 3, openAt: 0 });
    const a = p.decide(ctx(view("flat"), state({ fundingRate: 0.0003 }), 0));
    expect(a).toMatchObject({ kind: "open", side: "short" });
  });

  test("opens LONG when rate < 0 (shorts pay, longs receive)", () => {
    const p = fundingStrategyPolicy({ collateral: "3", leverage: 3, openAt: 0 });
    const a = p.decide(ctx(view("flat"), state({ fundingRate: -0.0003 }), 0));
    expect(a).toMatchObject({ kind: "open", side: "long" });
  });

  test("flips to stay on the receiving side when the rate changes sign", () => {
    const p = fundingStrategyPolicy({ collateral: "3", leverage: 3, openAt: 0 });
    // It is short (was the receiving side), but rate just went negative → longs now receive → flip.
    expect(p.decide(ctx(view("short"), state({ fundingRate: -0.0001 }), 3)).kind).toBe("close");
    // It is long and the rate is positive → shorts receive → flip.
    expect(p.decide(ctx(view("long"), state({ fundingRate: 0.0001 }), 3)).kind).toBe("close");
  });

  test("holds while already on the receiving side", () => {
    const p = fundingStrategyPolicy({ collateral: "3", leverage: 3, openAt: 0 });
    expect(p.decide(ctx(view("short"), state({ fundingRate: 0.0003 }), 3)).kind).toBe("none");
  });

  test("does NOT flip while the rate dithers inside the deadband (no churn near 0)", () => {
    const p = fundingStrategyPolicy({
      collateral: "3",
      leverage: 3,
      openAt: 0,
      flipDeadband: 0.0001,
    });
    // A SHORT pays only when rate < 0. Rate barely negative but inside the deadband → hold (no churn).
    expect(p.decide(ctx(view("short"), state({ fundingRate: -0.00005 }), 3)).kind).toBe("none");
    // A LONG pays only when rate > 0. Rate barely positive but inside the deadband → hold.
    expect(p.decide(ctx(view("long"), state({ fundingRate: 0.00005 }), 3)).kind).toBe("none");
    // Once the rate is decisively past the deadband against the held side → flip. Short pays at
    // rate < −deadband:
    expect(p.decide(ctx(view("short"), state({ fundingRate: -0.0002 }), 3)).kind).toBe("close");
    // Long pays at rate > +deadband:
    expect(p.decide(ctx(view("long"), state({ fundingRate: 0.0002 }), 3)).kind).toBe("close");
  });
});

describe("darkPolicy — opens, then goes silent", () => {
  test("opens a long once at openAt", () => {
    const p = darkPolicy({ collateral: "1", leverage: 20, openAt: 0, goesDarkAt: 2 });
    const a = p.decide(ctx(view("flat"), state(), 0));
    expect(a).toMatchObject({ kind: "open", side: "long", collateral: "1", leverage: 20 });
    expect(p.decide(ctx(view("long"), state(), 1)).kind).toBe("none");
  });

  test("isDark flips at goesDarkAt (the runner stops answering its calls)", () => {
    const p = darkPolicy({ collateral: "1", openAt: 0, goesDarkAt: 3 });
    expect(isDarkPolicy(p)).toBe(true);
    expect(p.isDark(0)).toBe(false);
    expect(p.isDark(2)).toBe(false);
    expect(p.isDark(3)).toBe(true);
    expect(p.isDark(10)).toBe(true);
  });

  test("declares it does not answer margin calls (static flag is false)", () => {
    expect(darkPolicy({ collateral: "1" }).answersMarginCalls).toBe(false);
  });
});
