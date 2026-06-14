# @sidekick/cre — Chainlink CRE workflows (Phase 6)

Two CRE workflows (TypeScript SDK → WASM) form the verifiable Layer-C orchestration for the SideKick
venue. Both are the **primary CRE bounty target ($6k)** and the **Connect-the-World** on-chain-state-change
target: a Chainlink `KeystoneForwarder` (a Chainlink contract on Arc) calls our consumer's `onReport`,
which is the qualifying on-chain write.

| Workflow | Job | Consumer it writes to |
|---|---|---|
| [`markfeed/`](./markfeed) | Fetch + DON-verify a Data Streams price (LINK/USD) and deliver the mark on-chain | [`MarkReceiver`](../contracts/src/oracle/MarkReceiver.sol) (`onReport` → stores the mark) |
| [`settle/`](./settle) | Read the on-chain mark + open-account set, then drive the authoritative §4.3 `checkpoint` | [`CheckpointSettler`](../contracts/src/oracle/CheckpointSettler.sol) (`onReport` → `engine.checkpoint`) |

```
markfeed:  Data Streams REST (HMAC) → DON median consensus → writeReport
             → KeystoneForwarder → MarkReceiver.onReport          ← on-chain state change (mark)
settle:    read MarkReceiver.getMark() + PerpEngine.openAccounts() on-chain → DON consensus → writeReport
             → KeystoneForwarder → CheckpointSettler.onReport → PerpEngine.checkpoint(...)   ← on-chain state change (settlement)
```

## Topology — the two workflows MUST share one venue

The settlement workflow reads the mark from the **same `MarkReceiver` the mark-feed workflow writes to**.
The end-to-end story ("CRE delivers a mark, then CRE settles on it") only reproduces when
`markfeed/config.json` and `settle/config.json` name the **same** `markReceiverAddress`.

This repo targets the **isolated CRE-settled venue** stood up by
[`script/DeployCreVenue.s.sol`](../contracts/script/DeployCreVenue.s.sol) (kept separate from the live
Arc venue so the working deployment is untouched). Its current addresses (redeployed 2026-06-13 with the
underflow-fixed contracts; a full live run is in [`evidence/RESULTS.md`](./evidence/RESULTS.md)):

| Component | Address |
|---|---|
| `PerpEngine` (owned by the settler) | `0x6d4A9355585Df1c9919D09c1842f09d1231Fe848` |
| `MarkReceiver` (markfeed writes, settle reads) | `0x559074a39b5A10B1492D2423b069b692ad2C9c64` |
| `CheckpointSettler` (owns the engine) | `0xad5797964eBACecC1Ef49FF4Cf6E4B89F9c38690` |
| `Vault` / `Pool` / `LPToken` | `0x8b0caC0F90ceEBb899D550404E6849a6dA51C62c` / `0xa75949f6fED775DECd00eFA19aD149cec73C73Bf` / `0x4F3c55D26078416DB1bA98B9e110285b4A162a83` |
| market | `LINK-PERP` (`marketId` = right-padded `"LINK-PERP"`) |
| Data Streams feed (LINK/USD testnet) | `0x00036fe43f87884450b4c7e093cd5ed99cac6640d8c2000e6afc02c8838d0265` |

> If you redeploy the CRE venue, update **both** config files' `markReceiverAddress` to the new
> `MarkReceiver`, plus `settle/config.json`'s `perpEngineAddress` / `settlerAddress`. They are kept in
> lockstep on purpose — a mismatch silently breaks the end-to-end run (the settle read reverts
> `StaleMark` because nothing ever wrote a mark into the receiver it reads).

Both `MarkReceiver` and `CheckpointSettler` allowlist **two** forwarders (set in `DeployCreVenue`):
the production Arc KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` and the local CRE
simulator forwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` — so `cre workflow simulate
--broadcast` lands a real on-chain write while production stays gated to Chainlink's forwarder.

## Run order

```bash
# 0. (once) deploy the isolated venue + seed an account to settle:
#    forge script script/DeployCreVenue.s.sol --rpc-url arc_testnet --broadcast
#    bun run packages/engine/src/scripts/cre-venue-setup.ts --vault .. --pool .. --engine .. --mark 8000000000000000000

# 1. build both workflows to WASM (also a full typecheck against the real CRE SDK):
cre workflow build ./markfeed
cre workflow build ./settle

# 2. deliver the mark, THEN settle on it (order matters — settle reads what markfeed wrote):
cre workflow simulate ./markfeed --broadcast --target arc
cre workflow simulate ./settle   --broadcast --target arc
```

Secrets (`CHAINLINK_API_KEY` / `CHAINLINK_API_SECRET`, the Data Streams credentials) are read from the
environment via [`secrets.yaml`](./secrets.yaml) — never hard-coded.

## Multiple feeds → the LIVE venue (ETH-PERP + LINK-PERP)

The live venue runs **two** Chainlink-sourced markets, each its own feed → its own `MarkReceiver` (the
per-market oracle adapter in [`deployments.ts`](../shared/src/deployments.ts)). The *same* `markfeed`
workflow delivers both — one config per feed (`workflow.yaml` always loads `./config.json`, so swap it
in per run; the named files are the source of truth):

| Market | Feed (Data Streams) | MarkReceiver (live venue) | Config |
|---|---|---|---|
| ETH-PERP | ETH/USD `0x000359843a…` | `0xaa79bc28…996346b…585617c` | [`config.eth.json`](./markfeed/config.eth.json) (= default `config.json`) |
| LINK-PERP | LINK/USD `0x00036fe4…` | `0xb9f26b08…aec5d37` | [`config.link.json`](./markfeed/config.link.json) |

```bash
# ETH (config.json already = config.eth.json):
cre workflow simulate ./markfeed --broadcast --target arc
# LINK (swap the active config, then run):
cp markfeed/config.link.json markfeed/config.json
cre workflow simulate ./markfeed --broadcast --target arc
cp markfeed/config.eth.json markfeed/config.json   # restore the default
```

> Only ETH/USD + LINK/USD return live reports on this testnet Data Streams account (BTC/SOL `404`,
> HYPE has no feed) — so the live set is exactly these two real-feed markets. The `0x559074…`
> `MarkReceiver` below is the **isolated** CRE-settle venue (`DeployCreVenue.s.sol`), a separate
> evidence track — not the live markets.

## Capturing live-run evidence (do this before the demo)

The chain of custody is proven in Foundry (`forge test --match-contract "MarkReceiver|CheckpointSettler"`),
but a "proven live on Arc" claim needs a **tracked** artifact, not prose. `docs/` is gitignored, so put
evidence under a tracked path here:

```bash
mkdir -p evidence
cre workflow simulate ./markfeed --broadcast --target arc 2>&1 | tee evidence/markfeed-run.log
cre workflow simulate ./settle   --broadcast --target arc 2>&1 | tee evidence/settle-run.log
# then read the counters back so the log shows the state actually changed:
#   MarkReceiver.reportCount()  PerpEngine.checkpointCount(LINK)  CheckpointSettler.settleCount()
```

Until those logs (with their `onReport written on-chain: 0x…` tx hashes + counter read-backs) exist,
describe §6.3/§6.5 as **"built + locally simulated"**, not "proven live."
