<div align="center">

# SideKick Perps

**An agent-native perpetual futures venue on [Arc](https://docs.arc.io).**
Per-block continuous funding · no liquidations · gas-free nanopayment settlement.

</div>

---

## The one-liner

SideKick is a perpetuals venue built for autonomous agents instead of human traders. Human
perp venues bake in three assumptions that only exist because people are slow — funding settles
every 8 hours, you get **liquidated at a penalty** when you cross a threshold, and you trade
through an **order book of static orders**. Agents break all three: they respond every block. So
we deleted those assumptions and rebuilt the venue for participants that act every ~2 seconds.

## The problem (why agents consume perps differently)

It is structural, not preference. Three human-era assumptions, each a workaround for human
reaction time:

- **Discrete funding (1–8h).** You cannot ask a human to settle a cashflow every few seconds, so
  venues batch it — creating funding-boundary games and a lumpy signal.
- **Threshold liquidation with penalty.** A human can't answer a margin call in 200ms, so the
  venue force-closes at a penalty and pays a keeper. The buffer, keepers, penalty, insurance
  fund, and ADL are all workarounds for slowness.
- **Static orders in a book.** A human's intent is static between decisions, so a passive store
  of frozen orders is the right abstraction.

An agent has none of these limits. SideKick replaces them with:

| Human-era assumption | SideKick |
|---|---|
| Funding every 8h | **Per-block continuous funding** — a clean, tradeable stream agents can hold in isolation |
| Threshold liquidation + penalty | **Continuous margin reconciliation** — miss a call and your position *decrements smoothly*, no cliff, no penalty |
| Static order book | Pool-as-counterparty + agent market-makers (intent-native matching is the design-doc endpoint) |

None of this was buildable until Circle shipped **gas-free batched nanopayments** — per-block
funding means thousands of sub-cent payments per block, economically impossible as on-chain
transactions until months ago.

> A SideKick margin call **is** a Circle **Nanopayment** — the same EIP-3009 / Circle Gateway flow
> Circle ships as a first-class pillar of its Agent Stack (`@circle-fin/x402-batching`). We don't
> emulate the pattern; we call the canonical rail. See [§ Answer margin calls](AGENTS.md#6-answer-margin-calls-gas-free-the-headline-flow).

## Architecture — the three-layer settlement model

Value moves through three layers: **A computes who owes whom (off-chain), B moves it as signed
authorizations (off-chain), C checkpoints truth to the chain (on-chain, batched).**

```
                            ┌──────────────────────────────────────────────┐
   mark (Stork│Chainlink) ─▶│  LAYER A — Compute loop   (our Bun service)   │
   via pluggable adapter    │  every ~2s Arc block:                         │
                            │  mark → fund → check → call → settle → decr.  │   §4.3 loop order
                            │  emits deltas (who owes whom, what shrank)     │
                            └───────────────────────┬──────────────────────┘
                                                    │ deltas
                                                    ▼
                            ┌──────────────────────────────────────────────┐
                            │  LAYER B — Value transfer  (Circle Gateway)   │
                            │  EIP-3009 / x402 signed authorizations,       │   @circle-fin/
                            │  zero gas, against unified balances           │   x402-batching
                            │  hundreds of sub-cent payments per block      │
                            └───────────────────────┬──────────────────────┘
                                                    │ accumulated state
                                                    ▼
                            ┌──────────────────────────────────────────────┐
                            │  LAYER C — Settlement + checkpoint (on Arc)   │
                            │  batch-settle + post authoritative state.     │   Chainlink CRE
                            │  THIS IS THE CHAINLINK CRE WORKFLOW           │   workflow (Phase 6)
                            │  (verified mark delivery + state transition)  │
                            └──────────────────────────────────────────────┘
```

The hot loop (A+B) runs in our own fast Bun service; **Chainlink CRE** does the verifiable,
periodic Layer C work (mark delivery + batch settlement) where BFT-consensus latency is free and
the guarantee is the point. The mark is read through a **pluggable oracle adapter** — Stork *or*
Chainlink, swappable per-market.

> Deeper reasoning, the exact funding/decrement formulas, the pool-solvency layers, and the
> judge Q&A live in the design docs (kept locally, not in this repo).

## Monorepo layout

Bun workspaces. TypeScript + Bun runtime, Hono for services, Foundry for contracts, Next.js +
Tailwind v4 + three.js for the dashboard (custom "mission-control" UI; no component-library
dependency), viem for chain interaction.

```
sidekick/
├─ packages/
│  ├─ shared/      @sidekick/shared    — types, 5 market configs, pluggable oracle adapter,
│  │                                     Arc/Circle/Stork/Chainlink constants   ✅ Phase 0
│  ├─ contracts/   @sidekick/contracts — Foundry: venue contracts (Phase 2) + Phase 0 spikes ✅
│  ├─ engine/      @sidekick/engine    — off-chain per-block loop (Layer A+B); §4 core math ✅;
│  │                                     economic simulation (Phase 1) + live service (Phase 3)
│  ├─ sdk/         @sidekick/sdk       — agent-facing client (Phase 5)
│  ├─ mcp/         @sidekick/mcp       — MCP server: the venue as tools for any LLM agent
│  ├─ cre/         @sidekick/cre       — Chainlink CRE workflow, Layer C (Phase 6, $6k bounty)
│  └─ agents/      @sidekick/agents    — autonomous demo agents (Phase 4)
├─ examples/                           — copy-pasteable agent examples (standalone-agent.ts)
├─ AGENTS.md                           — the single agent-facing reference (read this to integrate)
└─ apps/
   └─ web/         @sidekick/web       — read-only observability dashboard (Phase 7) ✅
                                          (3D settlement network; live engine + replay fallback)
```

## How to run

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.3, [Foundry](https://getfoundry.sh), and a
throwaway wallet funded with testnet USDC from the [Circle faucet](https://faucet.circle.com)
(USDC is Arc's gas token).

```bash
# 1. install workspace deps
bun install

# 2. restore Foundry libs (forge-std + OpenZeppelin are reinstallable, not committed)
cd packages/contracts
forge install foundry-rs/forge-std@v1.16.1 --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 --no-git
forge build && cd ../..

# 3. configure env — copy the template and fill in your funded key
cp .env.example .env
#   → set PRIVATE_KEY (and optionally ALCHEMY_ARC_RPC_URL); all public addresses are pre-filled

# 4. (optional) make a fresh throwaway wallet
cast wallet new            # copy the private key into .env, fund the address at the faucet

# 5. run the Phase 0 spikes against Arc testnet — all three pass
bun run spike:arc          # Arc deploy + USDC gas + WSS read-back
bun run spike:oracle       # oracle mark read via the pluggable adapter (Stork)
bun run spike:gateway      # Gateway nanopayment round-trip (@circle-fin/x402-batching)
```

See [`packages/contracts/spikes/README.md`](packages/contracts/spikes/README.md) for what each
spike confirms and the live results.

```bash
# 6. run the live venue + the observability dashboard
bun run engine             # the per-block loop (REST :8787 + WS /ws)
bun run demo               # (optional) drive the five autonomous demo agents
bun run web                # the dashboard → http://localhost:3000
#   the dashboard shows LIVE data when the engine is up; with no engine it falls back to a
#   deterministic in-browser replay of the venue math, so it is never blank.
```

## Build status

**Phases 0–7 complete. The Arc + Circle spine is live end-to-end, the Chainlink CRE workflow is
proven live, and the observability dashboard is built.**

- **Phase 0 — scaffold + spikes: ✅.** Monorepo wired; `@sidekick/shared` seeded with the five
  markets + pluggable oracle adapter + constants; all three spikes pass live on Arc (deploy + USDC
  gas + WSS, on-chain oracle read, Gateway unified-balance round-trip).
- **Phase 1 — economic simulation: ✅.** `packages/engine/src/sim` (float) tunes + writes back the
  swept constants `m=0.01, α=r_max, λ=0.08, r_max=0.0005, k=3`. `bun run sim`.
- **Phase 2 — contracts: ✅ built, tested (72 Foundry tests), and DEPLOYED LIVE to Arc Testnet**
  (chain 5042002). Real addresses are in `packages/shared/src/deployments.ts` (`isDeployed: true`):
  Vault, MarketRegistry, PerpEngine, AccountManager + a Pool/slpUSDC/StorkAdapter per market.
  Collateral is the **canonical Arc testnet USDC** `0x3600000000000000000000000000000000000000` (6dp,
  also the gas token). The full open→checkpoint→close loop is verified on-chain.
- **Phase 3 — off-chain engine (Layers A+B): ✅ live.** `packages/engine` runs as a Hono service
  (`bun run dev`) that loops per Arc block: reads the mark (live Stork for BTC; deterministic
  synthetic fallback for the assets Stork hasn't pushed on testnet — ETH/SOL/HYPE/LINK), runs the
  §4.3 reconciliation in **fixed point** (bit-for-bit parity with the on-chain Solidity — see
  `packages/engine/src/fixed`), triggers the on-chain `checkpoint`, settles Layer B margin-call
  **nanopayments** via the x402 seller endpoint, and streams per-block state over WebSocket. 86
  engine tests + 72 contract tests green. See `packages/engine/README.md` for the full surface
  and the live scripts (`bun run live:open`, `bun run live:tick`).

- **Phase 4 — demo agents: ✅.** `packages/agents` ships the five archetypes (long, short, MM,
  funding-strategy hero, dark) as pure policies driven by an autonomous runner over the SDK's WS
  stream. `bun run fund` onboards the fleet; `bun run demo` runs the scripted scenario.
- **Phase 5 — SDK + onboarding: ✅.** `@sidekick/sdk` — the agent-facing read / act / subscribe /
  onboard client; the demo agents are its first consumer.
- **Phase 6 — Chainlink CRE (primary $6k bounty): ✅ proven live on Arc.** `packages/cre` — one CRE
  workflow delivers a real Data Streams LINK/USD mark on-chain (DON → KeystoneForwarder →
  `MarkReceiver.onReport`) and a second drives the authoritative `checkpoint` through
  `CheckpointSettler`. Committed tx hashes + evidence in `packages/cre/evidence/`.
- **Phase 7 — observability dashboard: ✅.** `apps/web` (Next.js + Tailwind v4 + three.js) — the
  per-block loop made visible: a 3D settlement network, the convex funding curve, the nanopayment
  stream, smooth decrement, pool health. Live against the engine's WS/REST, with a deterministic
  in-browser replay fallback so a cold URL is never blank. `bun run web`.

> **For contributors / agents:** the live contract addresses + the venue's unit conventions (USDC
> 6dp, mark/params WAD 18dp) are the source of truth in `packages/shared`. Note: a pool must be
> seeded with LP capital before any position can open (the Layer-2 OI cap is `k·capital`, so a
> 0-capital pool admits nothing) — `bun run live:open` does the seed + open in one step.

**Next:** Phase 8 — polish, deploy, submit (architecture diagram, demo video, bounty write-ups).

## Build an agent

Three entry points, smallest to largest. The full reference — every call, endpoint, and the data
model — is **[AGENTS.md](AGENTS.md)** (the one page to read before integrating).

**1. The SDK** — `@sidekick/sdk`. A stranger self-configures from the venue's own descriptor:

```ts
import { SideKick } from "@sidekick/sdk";

const sk = new SideKick({ network: "arc-testnet", privateKey });   // chain 5042002

const { markets } = await sk.venue();                              // discover: markets, params, addresses, cadence
await sk.onboard({ depositUSDC: "20", gatewayUSDC: "5" });         // Vault collateral + Gateway balance
sk.on("block", (s) => { /* live mark, skew, funding, my positions, settlement — every ~2s */ });
await sk.open({ market: "ETH-PERP", side: "long", collateral: "20", leverage: 10 });
if (await sk.owed("ETH-PERP") > 0n) await sk.answerMarginCall("ETH-PERP");  // gas-free x402 nanopayment
// miss a call and your position decrements smoothly — there is no liquidation
```

**2. A runnable example** — [`examples/standalone-agent.ts`](examples/standalone-agent.ts): the full
discover → onboard → observe → decide → act → settle loop in one file, signed by a **Circle
developer-controlled (MPC) wallet** (no raw key in process).

```bash
cd packages/sdk && bun run circle:wallets --name my-agent --count 1   # create a wallet; fund its address
CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... CIRCLE_WALLET_ID=... \
  bun run example --collateral 10 --leverage 5 --blocks 30
```

**3. MCP** — `@sidekick/mcp` exposes every capability as MCP tools, so any LLM (Claude, etc.) trades
on SideKick by calling tools (`sidekick_venue`, `sidekick_open`, `sidekick_answer_margin_call`, …).
`CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... CIRCLE_WALLET_ID=... bun run mcp`, or wire it into an MCP
client — see [`packages/mcp`](packages/mcp).

The venue is **self-describing**: `GET /venue` (or `sk.venue()`) returns the live markets, their
params, the on-chain addresses, the cadence, the units, and a live headline snapshot — so an agent
needs zero hardcoded constants to start.

## Tech

`TypeScript` · `Bun` · `Hono` · `Foundry` · `viem` · `Next.js` · `Tailwind` · `shadcn/ui` ·
Arc Testnet · Circle Gateway (`@circle-fin/x402-batching`) · Stork / Chainlink oracles ·
Chainlink CRE.