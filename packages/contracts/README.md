# @sidekick/contracts

The Foundry project: the **Phase 2 on-chain venue** — the Solidity that custodies collateral,
records positions, holds the per-market pool, and runs the §4.3 reconciliation loop on-chain — plus
the math libraries it is built on, the Phase 0 spike contracts, and their TypeScript runners.

The contracts are the on-chain port of the Phase-1 economic simulation (`packages/engine/src`). The
math is mirrored **exactly**; the conventions and the deliberate on-chain divergences are documented
below and pinned by tests.

## Layout

```text
src/
  lib/
    SignedWad.sol        # signed 18-dp fixed-point (mul/div/abs/clamp) — the dimensionless math
    Funding.sol          # §4.1 funding: skew, EMA, convex-clamped rate, per-block payment
    Decrement.sol        # §4.2 decrement rule + §4.3 health check (N'=E/m, gap branch)
  generated/
    Params.sol           # GENERATED from @sidekick/shared by `bun run gen:params` (do not edit)
  Types.sol              # shared structs/enums (Side, Position, MarketParams)
  MarketRegistry.sol     # registry of markets {m,α,λ,r_max,k} + pool + oracle config (admin)
  Vault.sol              # USDC custody + free-collateral ledger (single-pot; operator-gated)
  Pool.sol               # per-market: capital, gap fund, net exposure, Layer-2 OI cap, mints slpUSDC
  LPToken.sol            # the branded slpUSDC LP share (one per pool, pool-gated mint/burn)
  PerpEngine.sol         # the §4.3 state machine: open/close + checkpoint(mark→fund→check→decrement)
  AccountManager.sol     # the unified-account view (collateral + position [+ ERC-8004 identity])
  oracle/                # IOracleAdapter + StorkAdapter (Spike B; mark injected in Phase 2)
  test/SideKickUSDC.sol  # 6-dp mock USDC — LOCAL tests/dry-runs only (Arc uses canonical USDC)
  spikes/Ping.sol        # Spike A throwaway
script/
  Deploy.s.sol           # stand up + wire the full venue, register all 5 markets (not yet broadcast)
  gen-params.ts          # codegen: markets.ts (TS) → generated/Params.sol (WAD) — one source of truth
test/
  Deployers.sol          # wired-venue harness mirroring the deploy graph
  lib/*.t.sol            # SignedWad / Funding / Decrement unit tests (pinned to the sim's values)
  Vault / Pool / Registry / PerpEngine .t.sol   # contract + integration tests
  invariant/             # stateful fuzz: OI-cap admission, USDC conservation, pool solvency
```

## The contract set (Doc 2 §2.1)

| Contract | Role |
|---|---|
| `MarketRegistry` | Per-market config: `{m, α, λ, r_max, k}`, the Pool, and the oracle adapter + feed id. Admin-only. |
| `Vault` | Custodies the canonical USDC and tracks each account's **free collateral**. All USDC lives in one pot here; capital / margin / gap fund / free collateral are claims on it. Mutations outside deposit/withdraw are **operator-gated** (the engine + pools). |
| `Pool` (one per market) | The universal counterparty + decrement absorber. Holds `capital`, the **gap fund**, and the net exposure; enforces the Layer-2 OI cap (`exposure ≤ k·capital`); mints the branded `slpUSDC` LP token. (The doc's standalone `GapFund` is the gap-fund **state inside the Pool** — isolated per market by construction.) |
| `LPToken` (slpUSDC) | The cleanly-branded LP share, one per pool, pool-gated mint/burn. |
| `PerpEngine` | The authoritative §4.3 state machine. `openPosition`/`closePosition`, and `checkpoint(marketId, mark, accounts)` runs mark → fund → check → settle → decrement **on-chain** for every position, atomically. Sole writer of pool exposure → the loop ordering can't be split (anti-double-count). |
| `AccountManager` | The unified-account read view (collateral + position), with an optional ERC-8004 identity link (Doc 1 §8). |

## Fixed-point conventions (the Phase-2 port)

The sim is pure float; on-chain everything is integer, in **two units**:

- **USDC amounts** (collateral, margin, equity, capital, gap fund, notional): **6-decimal atomic**
  — the canonical Arc USDC / Gateway precision.
- **Mark price + dimensionless params** (`m, α, λ, r_max`, skew, funding rate): **WAD (1e18)** signed
  fixed point. `k` is a plain integer.

A position is stored as `{side, entryNotional (6dp), entryMark (18dp), margin (6dp)}` — no separate
base-asset `qty` unit. `pricePnl = entryNotional·(mark − entryMark)/entryMark`, which is
algebraically `qty·Δprice`. This keeps the whole system in those two units with no third.

### Deliberate on-chain divergences from the sim (documented, tested)

The sim is float and can let intermediate values go negative; the on-chain venue must stay **cash-
backed** — at the end of every operation `Σ(claims) == vault USDC balance`. Two divergences make that
hold, and both are pinned by tests:

1. **Funding moves only real cash.** A position cannot pay funding out of unrealized PnL on-chain, so
   funding debits a position's `margin` cash floored at 0; any resulting shortfall vs maintenance is
   caught by the margin-call/decrement path (which realizes PnL into cash). The pool receives exactly
   the cash that left margins.
2. **Insolvency is absorbed, never reverted.** When the pool owes more than it holds (a winning
   trader's profit exceeds capital, or a gap exceeds the gap fund), capital is paid down to 0, the gap
   fund covers the overflow, and any residual is recorded bad debt — the trader is credited only the
   cash that existed. This conserves USDC **and** means a close/checkpoint can never be bricked by a
   winning counterparty (a liveness guarantee). The socialized-deleveraging tail (Doc 1 §3.3 L4) is
   the design endpoint for the residual; it is out of scope for the POC.

## Build, test, format

```bash
forge build
forge test            # 72 tests: lib units + integration + 3 stateful invariants
forge fmt
bun run gen:params    # regenerate src/generated/Params.sol after a fresh sweep (--write)
```

The suite includes a stateful **invariant** run (`test/invariant`) that drives random
open/close/checkpoint sequences and asserts, across thousands of calls: the OI-cap admission control
is never bypassed, USDC is conserved (within fixed-point dust), and the pool stays solvent. The
conservation invariant caught a real gap-fund accounting bug during development; an adversarial
multi-agent review then surfaced and we fixed a phantom-mint on underwater closes, an LP bank-run
surface, and a winning-close liveness brick — all now regression-tested.

## Deploy (Arc Testnet)

Built + fully tested in this phase; the **live broadcast is the explicit Phase-2 follow-up** once the
funded key is confirmed (avoids burning testnet state on not-yet-final contracts).

```bash
# Dry run (no broadcast) — wires + registers all 5 markets, logs every address:
forge script script/Deploy.s.sol

# Live (set the real Arc USDC + a multisig/timelock owner first):
USDC_ADDRESS=<canonical Arc testnet USDC> OWNER_ADDRESS=<multisig/timelock> \
  forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --verify
```

After a live run, copy the logged addresses into `@sidekick/shared` (`src/deployments.ts`) and flip
`isDeployed` to true. **`OWNER_ADDRESS` should be a multisig/timelock, not an EOA** — the owner can
grant Vault operators (who move the internal claim ledger), so it is the highest-value privilege in
the system. The deploy wires everything as the deployer, then transfers ownership to `OWNER_ADDRESS`.

## Dependencies (reinstall after a fresh clone)

`lib/forge-std` and `lib/openzeppelin-contracts` are reinstallable third-party deps and are
**git-ignored**. After cloning, restore them with pinned versions:

```bash
cd packages/contracts
forge install foundry-rs/forge-std@v1.16.1 --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 --no-git
```

`lib/stork-evm-sdk` IS committed (vendored from npm `@storknetwork/stork-evm-sdk@1.0.5`) — the
authoritative Stork interface the oracle adapter imports. Remappings live in `foundry.toml`, which
also enables `via_ir = true` (the dense §4.3 checkpoint loop exceeds the legacy stack).

## Spikes (Phase 0)

Run from the repo root with a funded `PRIVATE_KEY` in `.env`:

```bash
bun run spike:arc      # Spike A — Arc deploy + USDC gas + WSS read-back
bun run spike:oracle   # Spike B — oracle mark read via the pluggable adapter (Stork)
bun run spike:gateway  # Spike C — Gateway nanopayment round-trip (@circle-fin/x402-batching)
```

See [spikes/README.md](spikes/README.md) for what each confirms and the latest results.
