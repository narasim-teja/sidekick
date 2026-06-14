# @sidekick/sdk

The agent-facing TypeScript client for the SideKick venue — **the venue from a consumer's POV**
(Doc 2 Phase 5). An agent (or a human's script, or an MCP wrapper) installs this to **read** state,
**act** (open/close, post/withdraw collateral, provide liquidity), **subscribe** to the per-block
stream, **onboard**, and **answer margin calls** as gas-free Circle Gateway nanopayments.

It is a thin, ergonomic wrapper over surfaces that already exist — the deployed Arc contracts + the
live engine — **not new infrastructure**:

| SDK capability | Backed by |
|---|---|
| Read (`getState`, `getStatus`, `on("block")`) | the engine's REST + WebSocket (`@sidekick/engine`) |
| Act (`open`, `close`, `deposit`, `withdraw`, `provideLiquidity`) | direct `viem` writes to the **permissionless** contract functions |
| Answer margin call (`answerMarginCall`) | the x402 `/pay` buyer flow via Circle's `GatewayClient.pay()` |
| Onboard (`onboard`) | Gateway `deposit()` + Vault `deposit()` + optional ERC-8004 `linkIdentity()` |

Money/price units cross the boundary as **human decimal strings** ("20", "70627.5"); the SDK converts
to the venue's 6dp-USDC / 18dp-WAD integers at the edge using the engine's canonical fixed-point port,
so what the SDK sends on-chain is byte-identical to what the engine predicts and the contract stores —
no drift.

---

## Install

```bash
bun add @sidekick/sdk      # workspace: it's already linked in this monorepo
```

## Quickstart (Doc 2 §5.2)

```ts
import { SideKick } from "@sidekick/sdk";

// Construct with a raw private key (demo) OR a viem Account (KMS/hardware-wallet ready).
const sk = new SideKick({ network: "arc-testnet", privateKey });

// 1. Onboard: fund the Gateway unified balance (the off-chain balance nanopayments draw against),
//    post Vault trading collateral, and optionally link an ERC-8004 identity — one flow.
await sk.onboard({ depositUSDC: "100", gatewayUSDC: "20" });

// 2. Subscribe to the per-block state — the loop your agent hangs off of.
sk.on("block", (s) => {
  // s: mark, skew, fundingRate, positions, pool health, settlement flow (typed MarketBlockState)
});

// 3. Open a position. `leverage` is client-side sugar → notional = collateral × leverage
//    (the venue takes {notional, margin}; max leverage is bounded by the market's maintenance
//    fraction `m`, not a venue `leverage` primitive — Doc 3 §8). Or pass `notional` directly.
await sk.open({ market: "ETH-PERP", side: "long", collateral: "20", leverage: 10 });

// 4. Answer this block's margin call as a gas-free Gateway nanopayment (the headline Layer B flow).
//    Or simply keep enough Vault free collateral and let the on-chain checkpoint auto-settle it.
await sk.answerMarginCall("ETH-PERP");

// 5. Read your own account, or close out.
const me = await sk.getAccount("ETH-PERP");   // { side, margin, equity, freeCollateral, ... }
await sk.close("ETH-PERP");

sk.disconnect();   // close the WS stream on shutdown
```

### Config

```ts
new SideKick({
  privateKey,                 // OR  { account } — a viem Account, so the SDK is KMS-ready
  network: "arc-testnet",     // chain 5042002 (the only live network)
  engineUrl: "http://localhost:8787",  // the engine REST+WS base (default)
  // wsUrl, rpcUrl — optional overrides
});
```

> **Signer modes.** Reads, on-chain acts, AND the **Gateway nanopayment** path (`answerMarginCall`,
> Gateway `deposit`) all work with either a `privateKey` or a viem `Account` (the latter is KMS- and
> **Circle-MPC-ready** — see [`circle-account.ts`](src/circle-account.ts), the no-raw-key custody path
> the demo fleet, MCP server, and example all use). The nanopayment is signer-only via the x402 batch
> scheme, so no raw key is needed. The one exception is the raw Circle `GatewayClient` *handle*
> (`gateway()` / `gatewayBalance()`), whose constructor takes a raw key — that, and only that, needs
> `privateKey`. To broadcast writes through Circle's MPC API, also pass a `broadcaster` (from
> `circleSigner`/`circleBroadcaster`).

---

## How consumers connect (demo vs production)

The SDK serves three consumer modes from one core — useful to know for the demo:

1. **A developer's own agent (primary).** Write a TS bot, `new SideKick({...})`, hang a loop off
   `sk.on("block")`. This is exactly what the five demo agents in `@sidekick/agents` are — the SDK's
   first real consumers. They sign through **Circle developer-controlled (MPC) wallets** (no raw key in
   process); see [`circle-account.ts`](src/circle-account.ts). **This is what scales to 10–30 agents**:
   N processes, each a `SideKick` bound to its own Circle wallet.
2. **An MCP-capable agent (e.g. Claude via a connector) — the "any agent can trade" stretch.** Expose
   the SDK verbs (`open`, `close`, `getState`, `answerMarginCall`, `onboard`) as **MCP tools** behind a
   small MCP server; then any MCP host (Claude Desktop, a Claude connector, Cursor, another framework)
   trades on SideKick with zero bespoke integration — the model just calls the tools, the key stays
   server-side. This is the literal "agent-native, no human in the loop" realization (Doc 1 §7). It is
   a thin add-on over this client — ship the core first.
3. **A human's script.** Same as (1), driven by a person. The read-only dashboard (Phase 7) is the
   human's *view*; this SDK is how a human's script *acts*.

---

## Custody — Circle MPC wallets (the demo fleet) + the self-sovereign seam

The demo fleet (`@sidekick/agents`), the MCP server, and the example all sign through **Circle
developer-controlled (MPC) wallets** — the key is 2-of-2 MPC held by Circle and never materializes in
the process. Adapt one into a viem account with [`@sidekick/sdk/circle`](src/circle-account.ts):

```ts
import { SideKick } from "@sidekick/sdk";
import { circleSigner } from "@sidekick/sdk/circle";

const { account, broadcaster } = await circleSigner({ walletId, apiKey, entitySecret });
const sk = new SideKick({ account, broadcaster, engineUrl });   // trades + answers calls, no raw key
```

For a **self-sovereign** agent that brings its own key, `@sidekick/sdk/keys` derives EOAs from a single
BIP-39 mnemonic via the standard Ethereum HD path (`m/44'/60'/0'/0/<index>`) — handy for local
self-custody bots and N-agent scale/load tests (it is NOT how the demo fleet signs):

```ts
import { deriveFleet, generateAgentsMnemonic } from "@sidekick/sdk/keys";

const mnemonic = generateAgentsMnemonic();         // your own seed — you hold it
const fleet = deriveFleet(mnemonic, 30);           // 30 self-custodied agents at indices 1..30
```

---

## Surface

- **Read:** `getState(market)`, `getAllState()`, `getStatus()`, `on("block", cb)`, `getAccount(market)`,
  `freeCollateral()`, `getMarkWad(market)`, `owed(market)`.
- **Act:** `deposit(usdc)`, `withdraw(usdc)`, `open(opts)`, `close(market, mark?)`,
  `provideLiquidity(market, usdc)`, `withdrawLiquidity(market, shares, mark?)`.
- **Onboard:** `onboard({ depositUSDC?, gatewayUSDC?, identityId? })`.
- **Margin (x402 Gateway):** `answerMarginCall(market)`, `gateway()`, `gatewayBalance()`.

> **Impact pricing (Layer 3) is absent, not stubbed** — it is the STRETCH layer not yet on-chain
> (Doc 1 §3.3). When it lands it appears in the state payload; until then the SDK doesn't pretend it
> exists.

Types are re-exported from the engine + shared so consumers never hand-roll them: `MarketBlockState`,
`PositionState`, `PoolState`, `SettlementEvent`, `EngineStatus`, `MarketSymbol`, `MarketConfig`,
`MarketParams`, plus SDK types `OpenOptions`, `OnboardOptions`, `AccountView`.

## Tests

```bash
bun test src        # key derivation (determinism, 30-agent fleet) + unit conversions
```

See `docs/02-PHASED-BUILD-PLAN.md` Phase 5 and `docs/01-PROJECT-AND-ARCHITECTURE.md` §7.
