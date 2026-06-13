# @sidekick/engine

The off-chain per-block loop — **Layer A** (mark / fund / solvency / decrement compute) and
**Layer B** (Gateway nanopayment authorizations). The package wears two hats:

- **Phase 1 — economic simulation** (`src/sim`, `src/core`): a deterministic in-memory model in
  *float*, for the constants sweep. See the "Phase 1 simulation" section below.
- **Phase 3 — the live engine** (`src/index.ts`, `src/fixed`, `src/chain`, `src/compute`,
  `src/payments`): a real Hono service that loops against the **deployed Arc venue**, runs the §4.3
  reconciliation in **fixed point**, triggers the on-chain `checkpoint`, settles Layer B
  nanopayments, and streams per-block state over WebSocket.

See `docs/02-PHASED-BUILD-PLAN.md` Phase 1 + Phase 3 and `docs/01-PROJECT-AND-ARCHITECTURE.md` §4–§6.

---

## Phase 3 — the live engine

Each ~2s Arc block, for every configured market:

1. **Fetch the mark** through the pluggable oracle (`src/oracle`): the deployed `StorkAdapter`
   (BTC is live on testnet ≈ $70,627), falling back to a deterministic synthetic mark for assets
   Stork hasn't pushed (ETH/SOL/HYPE/LINK) — each tick labels its `markProvenance` honestly.
2. **Read authoritative state** from the venue (`src/chain`): open positions, free collateral, pool
   capital/exposure, and the carried EMA `smoothSkewPrev`.
3. **Run the §4.3 reconciliation off-chain** (`src/compute/reconcile.ts`) in **fixed point**
   (`src/fixed`) — `mark → fund → check → settle → decrement`, the exact ordering and integer
   arithmetic of `PerpEngine.checkpoint`, so the off-chain prediction equals the on-chain result.
4. **Record Layer B deltas** (`src/payments/ledger.ts`): the continuous funding stream + answered
   margin calls (settled via Gateway nanopayments — off-chain EIP-3009/x402 authorizations, not
   per-payment on-chain txns).
5. **Trigger the on-chain `checkpoint`** (`src/chain/venue.ts`) at the cadence — the authoritative
   state transition. Graceful fallback: reconcile every block, checkpoint every N
   (`CHECKPOINT_EVERY_BLOCKS`), and always reconcile the *newest* block if it falls behind 2s.
6. **Emit `MarketBlockState`** (`src/state.ts`) over WebSocket + REST for the SDK and dashboard.

### Fixed point — why a second math core

`src/core` (Phase 1) is float; the live loop triggers a *real on-chain checkpoint*, so it must
compute in the venue's integer units (USDC 6dp + WAD 18dp `bigint`) with the SAME truncating
division Solidity uses, or the off-chain prediction drifts from on-chain truth (the
PnL-double-count / conservation class Doc 1 §4.3 warns about). `src/fixed/*` is a **bit-for-bit
port** of `packages/contracts/src/lib/*`, proven by `src/fixed/parity.test.ts` against a vector
fixture emitted by `forge script script/GenParityVectors.s.sol` (`bun run gen:parity` in
`packages/contracts`). Same inputs in → same outputs out, on-chain and off.

### Layer B — the x402 seller

The engine is the *payee* (`src/payments`). It exposes an x402 margin-call resource via Circle's
`@circle-fin/x402-batching` server middleware (`POST /pay/:market/:account`), so an agent's
`GatewayClient.pay()` settles a sub-cent margin-call nanopayment against the venue (verified +
settled against Circle's testnet facilitator, gas-free), which the loop then lands on-chain via
`answerMarginCall`. This completes the round-trip Spike C left open.

### Run the live engine

```bash
# Requires a funded PRIVATE_KEY (the checkpoint operator) in the repo-root .env, and the live
# deployment in @sidekick/shared (already populated for Arc testnet).
bun run dev                 # the full service: per-block loop + WS stream + REST + x402 seller
bun run live:open -- --market BTC-PERP --side long --notional 2 --margin 1 --seed 3
                            # seed the pool (required — OI cap is k·capital) + open a position
bun run live:tick           # run ONE reconcile tick against Arc + print the state (and checkpoint)
```

HTTP (default port `8787`, override `ENGINE_PORT`):

- `GET /status` — engine status (markets, operator, cadence, tick counts).
- `GET /state` / `GET /state/:market` — the latest per-block `MarketBlockState`.
- `GET /settlement` — the recent Layer B authorization stream.
- `POST /pay/:market/:account` — the x402 margin-call resource (agents pay here).
- `ws://…/ws` — the per-block state stream (`{type:"block", state}` frames).

Env: `ENGINE_MARKETS=BTC-PERP,ETH-PERP` (or `all`), `CHECKPOINT_EVERY_BLOCKS=1`,
`ARC_LOGS_RPC_URL` (a wide-range `eth_getLogs` RPC for the event backfill — defaults to the public
Arc RPC, which allows 10k-block ranges; free-tier Alchemy caps it at 10).

---

## Phase 1 — economic simulation

The deterministic, in-memory, *float* model of one SideKick market that tunes the constants
`{m, α, λ, r_max, k}` before any Solidity is written, and doubles as judge evidence.

### Run it

```bash
bun run sim                 # run every scenario, print the report + the four §1.3 criteria
bun run sim <scenario>      # run one scenario (mixed-book | skew-wave | dark-decrement |
                            #   mm-rebalance | gap-event | funding-hero | funding-curve | stress)
bun run sim sweep           # grid-search {m,α,λ,r_max,k}, print the ranked table + winner (dry run)
bun run sim sweep --write   # …and write the chosen params back to packages/shared/src/markets.ts
bun test src                # unit + integration tests (core math, loop order, conservation, …)
```

The default `bun run sim` exits non-zero if any scenario fails its applicable criteria, so it
doubles as a CI gate on the economic model.

## What it models

A pure-float (Doc 2 Phase 1 is float; the on-chain port mirrors it in fixed point later),
side-effect-free model with three layers of state and one loop:

- **`account.ts`** — the unified account primitive (collateral + one position). Trader, LP, MM,
  funding-strategy agent — all the same object (Doc 1 §3.2).
- **`pool.ts`** — the pool as universal counterparty: capital, the gap fund, net exposure, and the
  **Layer-2 OI cap** admission control (`exposure ≤ k·capital`, Doc 1 §3.3).
- **`market.ts`** — the per-block engine. Runs the exact **§4.3 order** every block:
  `mark → fund → check → call → settle → decrement`. Health is always checked on the
  **post-funding** equity (the anti-double-count ordering a Pashov audit flagged in Ostium).
- **`agents.ts`** — agent policies: `long`/`short`, `skew-pusher`, `dark` (smooth decrement), `mm`
  (balancing side + funding carry), `funding-strategy` (the hero — rides the funding-receiving
  side, ~pure funding exposure), and `gap-victim` (the E ≤ 0 branch).
- **`scenarios.ts`** — named, reproducible runs (the Doc 2 §1.2 set + a funding-curve probe + a
  long integration `stress` run) and the `runScenario` driver.
- **`metrics.ts`** — the four Doc 2 §1.3 "good" criteria, each as a pass/fail with the numbers:
  funding curve (flat near balance, convex, no whipsaw), pool invariant, decrement smoothness,
  MM incentive.
- **`sweep.ts` / `writeback.ts`** — grid-search + auto-select (with a hard pool-invariant gate)
  and the surgical write-back of the chosen params into `@sidekick/shared`.
- **`invariants.ts`** — USDC conservation, asserted across every scenario in the tests.

### Conservation

The model neither creates nor destroys USDC. Funding is a transfer (traders ↔ pool); a decrement
is a forced partial close against the pool at mark; the **only** sink is the gap-fund draw on the
`E ≤ 0` branch. The pool is the universal counterparty, so its unrealized PnL is — by construction
— exactly `−Σ(open-trader unrealized PnL)`; realized PnL is booked into pool capital on every
close / decrement / gap. `bun test` asserts the total stays constant block-to-block in all
scenarios.

## Why single-threaded (no workers)

The whole simulation — including the full constants sweep — is **pure in-memory float
arithmetic**: a few hundred parameter combinations × a few thousand blocks each completes in well
under a second on one core (the sweep prints its own elapsed time). Workers would add IPC overhead,
serialization, and a determinism hazard for **zero** wall-clock benefit at this scale, and the
model is deterministic by design (seeded price paths) so results are reproducible run to run.
If the sweep grid ever grew large enough to matter, `parallel`-mapping `scoreParams` over a worker
pool is a drop-in change — but it is not warranted today.
