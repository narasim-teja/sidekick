# Trading on SideKick — the agent reference

This is the single page for building an agent that trades on **SideKick**, an agent-native perpetual
futures venue on Arc. It covers everything you can do, how to do it, and the exact shape of the data
you get back. If you read one file before integrating, read this one.

> **TL;DR.** `new SideKick({ privateKey })` → `sk.venue()` to self-configure → `sk.onboard(...)` →
> `sk.on("block", ...)` to watch live state → `sk.open(...)` / `sk.close(...)` to trade →
> `sk.answerMarginCall(...)` to settle, gas-free. There is **no liquidation** — miss a margin call
> and your position decrements smoothly. Full runnable example:
> [`examples/standalone-agent.ts`](examples/standalone-agent.ts).

## What makes this venue different (and what it means for your agent)

| Human venue | SideKick | What your agent does differently |
|---|---|---|
| Funding every 1–8h | **Per-block funding (~2s)** | Hold the funding-receiving side as a continuous yield; re-center every block |
| Liquidation at a penalty | **Smooth decrement, no cliff** | A missed margin call shrinks your notional to restore health — never a forced close at a penalty |
| Static order book | **Pool is the counterparty** | Open/close against the pool at the oracle mark; market-make by taking the under-represented side |
| On-chain tx per settlement | **Gas-free x402 nanopayments** | Answer margin calls off-chain via Circle Gateway; the engine batches truth on-chain |

**Funding sign convention:** funding flows from the over-represented side to the under-represented
side. If `skew > 0` (crowd is long), shorts *receive* funding and longs *pay*. Leaning against the
skew is the structural yield.

## 1. Connect

The recommended custody path is a **Circle developer-controlled (MPC) wallet** — the agent's key is
2-of-2 MPC held by Circle and never materializes in your process:

```ts
import { SideKick } from "@sidekick/sdk";
import { circleSigner } from "@sidekick/sdk/circle";

const { account, broadcaster } = await circleSigner({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  walletId: process.env.CIRCLE_WALLET_ID!,   // a funded Arc-testnet Circle wallet
});
const sk = new SideKick({
  network: "arc-testnet",                    // only live network (chain 5042002)
  account,
  broadcaster,                               // routes writes through Circle's MPC tx API
  engineUrl: "http://localhost:8787",        // the engine REST+WS base (default)
});
```

A **self-sovereign** agent can instead bring its own key — pass `privateKey` (or any viem `account`,
KMS / hardware-wallet ready) and omit `broadcaster`. The gas-free **Nanopayment** flow
(`answerMarginCall`) works either way — with an `account` it signs the EIP-3009 authorization through
your signer, so a real agent never hands over (or even materializes) a raw key. Only the *raw*
`gateway().deposit(...)` handle needs a `privateKey` (Circle's convenience `GatewayClient` constructor
takes one). Collateral is **Arc-testnet USDC** (`0x3600…0000`), which is also the gas token, so a
funded account needs only USDC.

## 2. Discover the venue (`sk.venue()`)

One call self-configures your agent — no hardcoded addresses or params.

```ts
const venue = await sk.venue();
// venue.markets[i] = { symbol, name, asset, marketId, params:{m,alpha,lambda,rMax,k},
//                      oracle:{source,assetId}, contracts:{pool,lpToken,oracleAdapter},
//                      live:{ mark, markProvenance, skew, fundingRate, oiLong, oiShort, poolCapital } | null }
const market = venue.markets.find(m => m.live?.markProvenance === "stork-live") ?? venue.markets[0];
```

`venue` also gives you `chainId`, shared `contracts` (vault, perpEngine, accountManager, usdc),
`cadence` (`blockSeconds`, `checkpointEveryBlocks`, `fundingPeriodSeconds`), and `units`
(collateral = USDC, 6dp; marks 18dp; **all amounts in payloads are decimal strings**). `params.m` is
the maintenance fraction — max leverage is ≈ `1/m`.

## 3. Onboard

```ts
await sk.onboard({
  depositUSDC: "20",        // → Vault free collateral (your trading margin)
  gatewayUSDC: "5",         // → Circle Gateway balance (what margin-call nanopayments draw against)
  registerIdentity: true,   // optional: mint a real ERC-8004 identity (see §6.5). Or `identityId: 42n` to link one.
});
```

Each step is skipped if its amount is absent. Depositing again just adds more. Check headroom with
`await sk.freeCollateral()` (returns bigint, 6dp).

## 4. Observe live state

Subscribe to the per-block stream (auto-reconnecting WebSocket):

```ts
const unsubscribe = sk.on("block", (state) => {
  // state: MarketBlockState — see §7. One frame per market per block (~2s).
  if (state.market !== market.symbol) return;
  // state.mark, state.skew, state.smoothSkew, state.fundingRate, state.oiLong/oiShort,
  // state.positions[], state.pool, state.settlement[]
});
// later: unsubscribe(); sk.disconnect();
```

Or poll REST (same payload):

```ts
const all  = await sk.getAllState();          // MarketBlockState[]
const one  = await sk.getState("BTC-PERP");   // MarketBlockState | null (null = no state yet)
const stat = await sk.getStatus();            // EngineStatus (running, markets, cadence, totals)
```

Your own joined account view at the live mark:

```ts
const me = await sk.getAccount("BTC-PERP");
// { address, market, side: "flat"|"long"|"short", entryNotional, entryMark, margin, equity, freeCollateral }
const markWad = await sk.getMarkWad("BTC-PERP");   // live mark (18dp bigint), on-chain oracle w/ engine fallback
```

## 5. Trade

```ts
// Open (one position per market; close to flip). Size by leverage OR explicit notional.
await sk.open({ market: "BTC-PERP", side: "long", collateral: "20", leverage: 5 });
await sk.open({ market: "BTC-PERP", side: "short", collateral: "20", notional: "100" });
// Close at the live (or supplied) mark; realizes PnL back to free collateral.
await sk.close("BTC-PERP");

// Collateral
await sk.deposit("50");     // wallet USDC → Vault (auto-approves)
await sk.withdraw("10");    // free collateral → wallet

// Liquidity (be the counterparty / earn the pool side)
await sk.provideLiquidity("BTC-PERP", "100");        // mints slpUSDC shares
await sk.withdrawLiquidity("BTC-PERP", "100");        // burns shares at the live mark
```

All act-methods return a tx hash immediately (no implicit wait). To wait:
`await sk.confirm(hash)` → `boolean`. Opens require enough free collateral; the venue enforces a
per-market open-interest cap (`k · poolCapital`) and admits or reverts.

## 6. Answer margin calls (gas-free, the headline flow)

Each block, the engine reconciles every position. If yours is short of maintenance it emits a margin
call. Answer it as a **gas-free Circle Gateway x402 nanopayment** — this is a Circle **Nanopayment**
in the literal sense (EIP-3009 authorization over Circle Gateway via `@circle-fin/x402-batching`, the
same rail Circle's Agent Stack ships), not a look-alike:

```ts
const owed = await sk.owed("BTC-PERP");        // bigint, 6dp — current shortfall (0 if healthy)
if (owed > 0n) {
  const r = await sk.answerMarginCall("BTC-PERP");
  // r = { settled: boolean, amount?, transaction?, reason? }
  // settled:false, reason:"no-open-margin-call" means you were already healthy (not an error)
}
```

**If you don't answer**, nothing catastrophic happens: the venue **decrements** your notional that
block to restore `equity ≥ m·N` — a smooth shrink, no liquidation, no penalty, no keeper. That's the
anti-liquidation guarantee. (If equity goes ≤ 0 the position gaps to the pool's gap fund.)

## 6.5. Identity (ERC-8004) — be a discoverable, reputation-bearing agent

SideKick agents are real **ERC-8004 ("Trustless Agents")** identities, not anonymous EOAs. Arc hosts
the canonical Identity + Reputation registries on-chain; one call mints you an identity NFT whose
payee `agentWallet` defaults to the very EOA that trades and answers margin calls.

```ts
// Mint a real identity (costs USDC gas — a real on-chain mint) and mirror it in-venue:
const { agentId } = await sk.registerAgent();      // → Identity Registry register() + linkIdentity()
const id = await sk.agentIdentity();
// id = { agentId, linked, agentWallet, namespacedId: "eip155:5042002:0x8004…/<agentId>" }
```

`venue().erc8004` gives you the registry addresses + namespace so you can resolve any SideKick agent's
identity/reputation with zero hardcoding. This completes the agentic loop —
**discover (`venue`) → pay (gas-free Nanopayment) → record (reputation)** — and it's the same
ERC-8004 standard Arc's agentic-economy track is built on. The payment hook ERC-8004 references *is*
x402, which is exactly the rail §6's margin calls already run on.

```ts
// Record (the loop's third leg): anchor a settled Nanopayment as on-chain reputation.
const r = await sk.answerMarginCall(m);                 // pay (gas-free), returns r.transaction
if (r.settled && r.transaction) await sk.recordPayment(id.agentId, { txHash: r.transaction, market: m });
const rep = await sk.reputationSummary(id.agentId);     // { count, value, valueDecimals }
```

## 7. The `MarketBlockState` shape (what every block/REST read returns)

All amounts are **decimal strings** (USDC); rates/skew are plain numbers.

```ts
interface MarketBlockState {
  market: MarketSymbol;
  tick: number;            // engine block counter
  arcBlock: number;        // Arc block this tick ran on
  mark: string;            // USD
  markProvenance: "stork-live" | "synthetic-fallback" | ...;  // honest label
  skew: number;            // raw S ∈ [-1,+1] = (oiLong-oiShort)/(oiLong+oiShort)
  smoothSkew: number;      // EMA-smoothed skew (what funding uses)
  fundingRate: number;     // per-period rate (clamp ±rMax)
  oiLong: string; oiShort: string;
  positions: Array<{
    account: string; side: "long"|"short";
    notionalBefore: string; notionalAfter: string;   // notionalAfter shrinks on a decrement
    equity: string; funding: string;                 // funding this block (+recv/-paid)
    call: string; paid: string;                      // margin call requested / answered
    outcome: "healthy"|"topped-up"|"decrement"|"gap";
  }>;
  pool: { capital, gapFund, exposure, cap, equity, fundingAccrued };  // all USDC strings
  settlement: Array<{ block, account, kind, amount, at }>;  // recent nanopayment stream
  checkpoint?: { txHash: string; index: number };  // set the blocks that landed on-chain
  at: number;              // engine timestamp ms
}
```

## 8. Engine HTTP/WS endpoints (if you skip the SDK)

| Method + path | Returns | Notes |
|---|---|---|
| `GET /venue` | `VenueDescriptor` | Self-description: markets, params, addresses, **erc8004 registries**, cadence, units, live snapshot |
| `GET /status` | `EngineStatus` | running, chainId, operator, markets, cadence, totals, ticks |
| `GET /state` | `MarketBlockState[]` | Latest state for every running market |
| `GET /state/:market` | `MarketBlockState` / 404 | 404 before the first checkpoint |
| `GET /settlement` | `SettlementEvent[]` | Recent 100 funding + margin-call events |
| `GET /owed/:market/:account` | `{ market, account, owed }` | `owed` is 6dp atomic string |
| `POST /pay/:market/:account` | x402 402→200 | The margin-call payment resource (sign EIP-3009, retry) |
| `WS /ws` | `{type:"hello"}` then `{type:"block", state}` | Per-block push; push-only |

## 9. Full lifecycle (the shape of a real agent)

```ts
const sk = new SideKick({ network: "arc-testnet", privateKey });
const { markets } = await sk.venue();                       // 1. discover
const m = markets.find(x => x.live?.markProvenance === "stork-live")!.symbol;
await sk.onboard({ depositUSDC: "20", gatewayUSDC: "5" });  // 2. onboard

sk.on("block", async (state) => {                            // 3. observe → 4. decide → 5. act
  if (state.market !== m) return;
  if (await sk.owed(m) > 0n) await sk.answerMarginCall(m);   // 6. settle (gas-free)
  const me = await sk.getAccount(m);
  const want = state.smoothSkew > 0.05 ? "short" : state.smoothSkew < -0.05 ? "long" : null;
  if (me.side === "flat" && want) await sk.open({ market: m, side: want, collateral: "10", leverage: 5 });
});
```

A complete, runnable version (with re-centering and close-out, signed by a Circle MPC wallet) is
[`examples/standalone-agent.ts`](examples/standalone-agent.ts) — `bun run example`.

## 10. Trade from an LLM (MCP)

Every capability above is exposed as MCP tools by [`@sidekick/mcp`](packages/mcp), so any MCP client
(Claude, etc.) can trade on SideKick by calling tools — `sidekick_venue`, `sidekick_identity`,
`sidekick_onboard`, `sidekick_open`, `sidekick_close`, `sidekick_account`, `sidekick_state`,
`sidekick_answer_margin_call`, `sidekick_record_payment`, `sidekick_reputation`. See that package's
README for wiring.

## 11. Gotchas

- **One position per market** (POC). Close to flip side or resize.
- **Decimal strings everywhere** in payloads/SDK args; the SDK converts to 6dp/18dp at the edge.
  Reads like `freeCollateral()` / `owed()` return raw bigints (6dp).
- **Synthetic vs live mark.** `markProvenance` tells you honestly. BTC/ETH have a live on-chain Stork
  mark; SOL/HYPE/LINK use a synthetic moving mark (Stork has no feed for them on this endpoint).
- **Pool must be seeded.** A market with zero pool capital admits no opens — pick a market whose
  `live.poolCapital > 0` (the descriptor shows it).
- **No retries built in.** Wrap act-methods if you need idempotency; the runner in `@sidekick/agents`
  shows a serialized per-agent loop pattern.
