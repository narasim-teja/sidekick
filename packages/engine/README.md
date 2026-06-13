# @sidekick/engine

The off-chain per-block loop — **Layer A** (mark / fund / solvency / decrement compute) and,
later (Phase 3), **Layer B** (Gateway nanopayment authorizations). In **Phase 1** this package is
the **economic simulation**: a deterministic, in-memory model of one SideKick market that lets you
*see* the funding curve, the pool-solvency bound, and continuous decrement behaving — and tune the
market constants `{m, α, λ, r_max, k}` before any Solidity is written.

See `docs/02-PHASED-BUILD-PLAN.md` Phase 1 and `docs/01-PROJECT-AND-ARCHITECTURE.md` §4 (the
funding + decrement math) for the design this implements.

## Run it

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
