# @sidekick/agents

The autonomous demo agents (Doc 2 Phase 4) that prove **"agent-to-agent, no human intervention"** and
drive the demo. Each is a small autonomous loop — *subscribe to the per-block state, decide, act,
repeat* — built on `@sidekick/sdk`.

## The five archetypes (Doc 2 §4.1, Doc 3 §11)

| Agent | Behaviour | Proves |
|---|---|---|
| **long** / **short** | Open a position, hold, answer per-block margin calls (x402 Gateway). | The per-block loop is alive; the book has two sides. |
| **mm** | Watch pool skew vs cap; take the **balancing** (minority) side; flip when the crowd flips. | Skew self-corrects on camera; the pool's exposure stays bounded. |
| **funding** (HERO) | Hold ~**pure funding exposure**: ride the funding-*receiving* side, re-centering each block. | Claim 1 — something you literally cannot express on an 8h-funding human venue. |
| **dark** | Open, then deliberately **go silent** (stop answering calls). | **No liquidation** — the venue decrements it smoothly toward zero, no cliff, no penalty. |

The **behaviours are fixed**; the **policy knobs** (sizing, leverage, staging, deadbands) live in
`scenario.ts` and are easy to tune for demo legibility. The pure decision functions are in
`policies.ts` (unit-tested); the impure shell that drives one against the live venue is `runner.ts`.

---

## Run it

Prereqs: the **engine running** (`bun run engine` from the repo root, or `bun run dev` in
`packages/engine`) and the fleet's **Circle wallets** created + funded. The fleet signs through Circle
developer-controlled (MPC) wallets only — there is no HD/seed fallback.

```bash
# 0. (first time) create a Circle wallet SET + 5 wallets (one per role), then set their ids in .env as
#    CIRCLE_WALLET_ID_LONG/_SHORT/_MM/_FUNDING/_DARK (or CIRCLE_AGENT_WALLET_IDS=id1,…,id5 in that
#    order), plus CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET. Fund EACH wallet's address with Arc-testnet
#    USDC at https://faucet.circle.com (USDC is gas + collateral on Arc).
cd ../sdk && bun run circle:wallets --name sidekick-agents --count 5 && cd ../agents

# 1. onboard all five agents (each Circle wallet deposits its own balance → Vault + Gateway)
bun run fund                      # or: bun run --filter @sidekick/agents fund
bun run fund -- --dry             # print each wallet's address + the amount it needs, without sending
bun run fund -- --only long,mm    # onboard a subset

# 2. run the scripted scenario (Doc 3 §11): seeds the pool, then runs all five agents with narration
bun run demo                      # or: bun run --filter @sidekick/agents demo

# …or run a single agent standalone:
bun run agent:long
bun run agent:funding             # the hero
bun run agent:dark                # watch it decrement after it goes silent
```

Config (all via `.env`, see `.env.example`): `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, the per-role
`CIRCLE_WALLET_ID_*` (or `CIRCLE_AGENT_WALLET_IDS`), `ENGINE_URL`, `AGENT_MARKET`. Missing/partial
Circle config fails loud with the exact var to set — no silent fallback.

> **Unfunded agent?** If a role's Circle wallet holds no USDC it simply can't onboard or open — it
> holds no position and doesn't trade (the deposit/open reverts, logged, no crash). And an agent that
> later can't answer a margin call just **decrements smoothly** (the no-liquidation design), it doesn't
> error. So "no funds → no trades" is the worst case; nothing breaks.

---

## Build order (the Doc 2 §4.1 decision)

Doc 2 §4.1 flags an ordering choice and recommends one — **we took it**: the SDK (Phase 5) was built
**first**, and these agents are its first real consumer. They act exclusively through `@sidekick/sdk`,
never against the raw engine API — so the SDK surface is validated by real use, with no rework.

## Custody & scale (Circle MPC wallets)

Every agent signs through its own **Circle developer-controlled (MPC) wallet** — the key is 2-of-2 MPC
held by Circle and never in this process; the operator's entity secret authorizes signing. Each role
maps to a Circle `walletId` (`CIRCLE_WALLET_ID_LONG/_SHORT/_MM/_FUNDING/_DARK`, or an ordered
`CIRCLE_AGENT_WALLET_IDS` list). `circleSkForRole(role)` in `config.ts` is the one seam that turns a
role into a Circle-backed `SideKick`; the runners + every script funnel through it. Scaling to N agents
is creating N Circle wallets (`bun run circle:wallets` in `@sidekick/sdk`) and funding their addresses.

> There is **no HD/mnemonic or raw-key fallback** for the fleet. (The SDK still exposes
> `@sidekick/sdk/keys` as a generic self-sovereign/scale-test utility, but the demo agents do not use
> it.) See the custody note in the SDK README.

## Margin-call path (the answered AskUserQuestion)

The demo agents answer margin calls via the **x402 Gateway nanopayment only** (the headline Layer B
flow — `GatewayClient.pay()` → the engine's `/pay/:market/:account` seller). So each answering agent
**must have a funded Gateway unified balance** — `bun run fund` deposits `gatewayUSDC` per the scenario.
The dark agent funds no Gateway balance on purpose (it never answers). An agent that runs out of
Gateway balance simply decrements — which is the venue working as designed, not a failure.

> Two answer paths exist in the venue (Doc 1 §5 Layer B); we chose the Gateway one for the agents.
> The other — keeping Vault free collateral so the on-chain `checkpoint` auto-settles — needs no
> Gateway balance and is the more robust fallback; switch a policy to it by funding more `vaultUSDC`
> and skipping `answerMarginCall`. Kept as the documented alternative, not wired by default.

---

## Open items, called out honestly (Doc 2 §4.1)

- **Pure-funding exposure — how literal?** True delta-neutrality needs the PT/YT leg split the POC
  venue doesn't natively expose (Doc 1 §2 Pattern 2 is design-doc). The **funding** agent is the
  documented stand-in: a single position kept on the funding-receiving side and re-centered every
  block. We lead the demo with what's true and don't overclaim.
- **Impact rebate (the MM's headline revenue) is Layer 3 / STRETCH** — not in the contracts yet
  (Doc 1 §3.3). Until it lands, the **mm** agent earns **funding carry only** (by sitting on the
  funding-receiving balancing side). That's a fine demo; the rebate is additive when Layer 3 ships.
- **Onboarding** — demo agents **pre-onboard via `bun run fund`** (the chosen path of the two Doc 2
  §4.1 options). Self-onboard-on-first-run is a one-line change (`sk.onboard(...)` at startup).

## Architecture

```
policy.ts      the AgentPolicy primitive (pure decide(ctx) → action)
policies.ts    the 5 archetypes (directional / mm / fundingStrategy / dark) — pure, unit-tested
scenario.ts    per-role sizing/leverage/staging (the Doc 3 §11 script) + policyForRole()
runner.ts      AgentRunner — the autonomous shell: subscribe → answer calls → decide → act
factory.ts     role → Circle MPC wallet → SideKick client → AgentRunner
config.ts      env loading + circleSkForRole/requireCircleFleet (the Circle custody seam), engine url, market
run-one.ts     the shared body of each `agent:<role>` entry
agents/*.ts    the five standalone runnable entries
orchestrator.ts  the `bun run demo` scenario (seeds the pool from the funding wallet, runs all five, narrates)
scripts/fund.ts  the `bun run fund` onboarding (each Circle wallet → Vault + Gateway deposit)
```

## Tests

```bash
bun test src     # policy decisions (each archetype) + scenario wiring + the runner loop (mocked SDK)
```

The runner test drives synthetic block frames through a mock `SideKick` and asserts the wiring the
demo depends on — including that the **dark agent stops answering once it goes silent** (the
no-liquidation proof), with no chain or engine needed.

See `docs/02-PHASED-BUILD-PLAN.md` Phase 4 and `docs/03-JUDGE-EXPLAINER.md` §11 (the demo script).
