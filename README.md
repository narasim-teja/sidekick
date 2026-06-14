<div align="center">

# SideKick Perps

**An agent-native perpetual futures venue on [Arc](https://docs.arc.io).**

Per-block continuous funding · no liquidations · gas-free nanopayment settlement.

`Arc Testnet` · `Circle Programmable Wallets + Gateway` · `Chainlink CRE` · `Stork`

</div>

---

## The one-liner

SideKick is a perpetuals venue built for autonomous agents instead of human traders. Human
perp venues bake in three assumptions that only exist because people are slow: funding settles
every 8 hours, you get **liquidated at a penalty** when you cross a threshold, and you trade
through an **order book of static orders**. Agents break all three, because they respond every
block. So we deleted those assumptions and rebuilt the venue for participants that act every
~2 seconds.

## The problem (why agents consume perps differently)

It is structural, not preference. Three human-era assumptions, each a workaround for human
reaction time:

- **Discrete funding (1 to 8h).** You cannot ask a human to settle a cashflow every few seconds,
  so venues batch it, which creates funding-boundary games and a lumpy signal.
- **Threshold liquidation with penalty.** A human cannot answer a margin call in 200ms, so the
  venue force-closes at a penalty and pays a keeper. The buffer, keepers, penalty, insurance
  fund, and ADL are all workarounds for slowness.
- **Static orders in a book.** A human's intent is static between decisions, so a passive store
  of frozen orders is the right abstraction.

An agent has none of these limits. SideKick replaces them with:

| Human-era assumption | SideKick |
|---|---|
| Funding every 8h | **Per-block continuous funding**, a clean tradeable stream agents can hold in isolation |
| Threshold liquidation + penalty | **Continuous margin reconciliation**: miss a call and your position *decrements smoothly*, no cliff, no penalty |
| Static order book | Pool-as-counterparty + agent market-makers (intent-native matching is the endpoint) |

None of this was buildable until Circle shipped **gas-free batched nanopayments**. Per-block
funding means thousands of sub-cent payments per block, economically impossible as on-chain
transactions until months ago.

> A SideKick margin call **is** a Circle **Nanopayment**, the same EIP-3009 / Circle Gateway flow
> Circle ships as a first-class pillar of its Agent Stack (`@circle-fin/x402-batching`). We do not
> emulate the pattern; we call the canonical rail. See [§ Answer margin calls](AGENTS.md#6-answer-margin-calls-gas-free-the-headline-flow).

## Architecture: the three-layer settlement model

Value moves through three layers. **A computes who owes whom (off-chain), B moves it as signed
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
                            │  THIS IS THE CHAINLINK CRE WORKFLOW           │   workflow
                            │  (verified mark delivery + state transition)  │
                            └──────────────────────────────────────────────┘
```

The hot loop (A+B) runs in our own fast Bun service. **Chainlink CRE** does the verifiable,
periodic Layer C work (mark delivery + batch settlement) where BFT-consensus latency is free and
the guarantee is the point. The mark is read through a **pluggable oracle adapter**, Stork or
Chainlink, swappable per-market.

## Live on Arc Testnet

Everything below is **deployed and verified on Arc Testnet** (chain `5042002`). Collateral is the
canonical Arc testnet USDC, which is also the gas token. Explorer:
[`testnet.arcscan.app`](https://testnet.arcscan.app).

### Core venue contracts

| Contract | Address |
|---|---|
| USDC (collateral + gas, 6dp) | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |
| Vault | [`0x4E78654a6DC9513a938477E69F0fe3F39A9AC0d0`](https://testnet.arcscan.app/address/0x4E78654a6DC9513a938477E69F0fe3F39A9AC0d0) |
| MarketRegistry | [`0x324CB5E497D1817c3B693a13944F5c0BDC444D6d`](https://testnet.arcscan.app/address/0x324CB5E497D1817c3B693a13944F5c0BDC444D6d) |
| PerpEngine | [`0x1ABeca7EA5963e0bf1a408658B27BAa274667E6c`](https://testnet.arcscan.app/address/0x1ABeca7EA5963e0bf1a408658B27BAa274667E6c) |
| AccountManager | [`0x1F9F7abC683342FC61AF003834edBC357f75EcbD`](https://testnet.arcscan.app/address/0x1F9F7abC683342FC61AF003834edBC357f75EcbD) |

Deployed at block `46,895,808` (2026-06-13). Source of truth:
[`packages/shared/src/deployments.ts`](packages/shared/src/deployments.ts).

### Markets (isolated pool per market)

| Market | Pool | Oracle adapter | Mark source |
|---|---|---|---|
| BTC-PERP | [`0xbB17…525F`](https://testnet.arcscan.app/address/0xbB17DE89413cB1Cc472977c50676321286cd525F) | [`0x7F4E…edE1`](https://testnet.arcscan.app/address/0x7F4E622c79378588b4E99f3a75d1f5fAa62aedE1) | Stork |
| ETH-PERP | [`0x3416…6642`](https://testnet.arcscan.app/address/0x34163040c9e570e991C02219d1627c633b2f6642) | [`0xaa79…617c`](https://testnet.arcscan.app/address/0xaa79bc289996346b3099a850b29239bdf585617c) | Chainlink CRE (Data Streams) |
| LINK-PERP | [`0x81a4…A8E8`](https://testnet.arcscan.app/address/0x81a445bf640e549E4b8aC00f19C76dB5de43A8E8) | [`0xb9f2…5d37`](https://testnet.arcscan.app/address/0xb9f26b08c50aefe367308d89f7a2dacf2aec5d37) | Chainlink CRE (Data Streams) |
| XAU-PERP | [`0x829b…0a9a`](https://testnet.arcscan.app/address/0x829b522152496c056ed74cc2881ba467bfdc0a9a) | [`0xa9e6…0d30`](https://testnet.arcscan.app/address/0xa9e662ac30f71adbff822864a9d0f946d75d0d30) | Stork |

> Stork pushes live on-chain marks for BTC and gold (XAU). ETH and LINK read a real Chainlink
> Data Streams price delivered through the CRE workflow.

### Chainlink CRE consumers

The CRE workflows run via local CRE simulation (`cre workflow simulate`), which posts to these
on-chain consumers on Arc: a markfeed workflow delivers a verified Data Streams mark to
`MarkReceiver.onReport`, and a settle workflow drives the authoritative `checkpoint` through
`CheckpointSettler` against a dedicated PerpEngine it owns. Tx hashes and evidence are in
[`packages/cre/evidence/`](packages/cre/evidence/).

| Consumer | Address |
|---|---|
| MarkReceiver (markfeed `onReport`) | [`0x5590…9c64`](https://testnet.arcscan.app/address/0x559074a39b5A10B1492D2423b069b692ad2C9c64) |
| CheckpointSettler (settle `onReport`) | [`0xad57…8690`](https://testnet.arcscan.app/address/0xad5797964eBACecC1Ef49FF4Cf6E4B89F9c38690) |
| PerpEngine (owned by the settler) | [`0x6d4A…Fe848`](https://testnet.arcscan.app/address/0x6d4A9355585Df1c9919D09c1842f09d1231Fe848) |

## Monorepo layout

Bun workspaces. TypeScript + Bun runtime, Hono for services, Foundry for contracts, Next.js +
Tailwind v4 + three.js for the dashboard (custom mission-control UI, no component-library
dependency), viem for chain interaction.

```
sidekick/
├─ packages/
│  ├─ shared/      @sidekick/shared    — types, market configs, pluggable oracle adapter,
│  │                                     deployment addresses, Arc/Circle/Stork/Chainlink constants
│  ├─ contracts/   @sidekick/contracts — Foundry: venue contracts + integration spikes
│  ├─ engine/      @sidekick/engine    — off-chain per-block loop (Layer A+B); §4 core math;
│  │                                     economic simulation + live service
│  ├─ sdk/         @sidekick/sdk       — agent-facing client (discover/onboard/act/subscribe)
│  ├─ mcp/         @sidekick/mcp       — MCP server: the venue as tools for any LLM agent
│  ├─ cre/         @sidekick/cre       — Chainlink CRE workflows, Layer C (markfeed + settle)
│  └─ agents/      @sidekick/agents    — autonomous demo agents (the five archetypes)
├─ examples/                           — copy-pasteable agent examples (standalone-agent.ts)
├─ AGENTS.md                           — the single agent-facing reference (read this to integrate)
└─ apps/
   └─ web/         @sidekick/web       — read-only observability dashboard
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

# 3. configure env: copy the template and fill in your funded key
cp .env.example .env
#   → set PRIVATE_KEY; all public addresses are pre-filled

# 4. (optional) make a fresh throwaway wallet
cast wallet new            # copy the private key into .env, fund the address at the faucet
```

The contracts are already deployed (see [Live on Arc Testnet](#live-on-arc-testnet)), so you can
point straight at the live venue. To run the loop and the dashboard:

```bash
# the per-block loop (REST :8787 + WS /ws)
bun run engine

# (optional) drive the five autonomous demo agents
bun run demo

# the dashboard → http://localhost:3000
bun run web
#   shows LIVE data when the engine is up; with no engine it falls back to a deterministic
#   in-browser replay of the venue math, so it is never blank.
```

To re-verify the integrations from scratch, the integration spikes run live against Arc:

```bash
bun run spike:arc          # Arc deploy + USDC gas + WSS read-back
bun run spike:oracle       # oracle mark read via the pluggable adapter (Stork)
bun run spike:gateway      # Gateway nanopayment round-trip (@circle-fin/x402-batching)
```

## Build an agent

Three entry points, smallest to largest. The full reference, every call, endpoint, and the data
model, is **[AGENTS.md](AGENTS.md)** (the one page to read before integrating).

**1. The SDK** — `@sidekick/sdk`. A stranger self-configures from the venue's own descriptor:

```ts
import { SideKick } from "@sidekick/sdk";

const sk = new SideKick({ network: "arc-testnet", privateKey });   // chain 5042002

const { markets } = await sk.venue();                              // discover: markets, params, addresses, cadence
await sk.onboard({ depositUSDC: "20", gatewayUSDC: "5" });         // Vault collateral + Gateway balance
sk.on("block", (s) => { /* live mark, skew, funding, my positions, settlement, every ~2s */ });
await sk.open({ market: "ETH-PERP", side: "long", collateral: "20", leverage: 10 });
if (await sk.owed("ETH-PERP") > 0n) await sk.answerMarginCall("ETH-PERP");  // gas-free x402 nanopayment
// miss a call and your position decrements smoothly: there is no liquidation
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
client. See [`packages/mcp`](packages/mcp).

The venue is **self-describing**: `GET /venue` (or `sk.venue()`) returns the live markets, their
params, the on-chain addresses, the cadence, the units, and a live headline snapshot, so an agent
needs zero hardcoded constants to start.

## What runs where (the Circle + Chainlink stack)

| Capability | How SideKick uses it |
|---|---|
| **Arc** | The USDC-native L1 the whole venue runs on. ~2s blocks, deterministic finality, USDC as gas. |
| **Circle Programmable Wallets** | Every agent trades from a developer-controlled MPC wallet. No raw key exists in process; the wallet signs nanopayments and broadcasts contract writes. |
| **Circle Gateway nanopayments** | Per-block funding and margin calls settle as gas-free EIP-3009 / x402 signed authorizations against a unified balance (`@circle-fin/x402-batching`). |
| **Chainlink CRE** | Run via local CRE simulation: one workflow delivers a verified Data Streams mark on-chain (DON → KeystoneForwarder → `onReport`), a second drives the authoritative `checkpoint`. The verifiable Layer C orchestrator. |
| **Stork** | Pull-based oracle for BTC and gold: a signed update is pushed on-chain before read, behind the same pluggable adapter interface. |
| **ERC-8004** | Arc-native on-chain agent identity, composing with the unified-account model. |

## Tech

`TypeScript` · `Bun` · `Hono` · `Foundry` · `viem` · `Next.js` · `Tailwind v4` · `three.js` ·
Arc Testnet · Circle Programmable Wallets + Gateway (`@circle-fin/developer-controlled-wallets`,
`@circle-fin/x402-batching`) · Stork / Chainlink oracles · Chainlink CRE.
