# Running SideKick locally — the demo runbook

A terminal-by-terminal guide to run the whole stack (backend engine → dashboard → autonomous agents)
against the **live Arc testnet** deployment, and what to say at each step.

> The contracts are already deployed on Arc testnet and the agents' Circle wallets are funded. You are
> running the **off-chain engine + dashboard + agents locally**; they all talk to the live on-chain venue.

---

## What you're running (the architecture in one breath)

```
 Arc testnet (LIVE on-chain)              Local (you run these)                   Judges see
 ───────────────────────────             ─────────────────────────               ──────────
 Vault / PerpEngine / Pools     ◀──reads/writes──   ENGINE  (Terminal 1)   ──REST/WS──▶  DASHBOARD (Terminal 2)
 4 markets, 2 oracles:                              the per-block loop                    live mark / skew /
   ETH·LINK  ← Chainlink (CRE)                      (mark→fund→checkpoint)                 funding / settlements
   BTC·XAU   ← Stork                                       ▲
 Circle Gateway (nanopayments)                            │ trade (open/close, answer calls)
 ERC-8004 identity                                  AGENTS  (Terminal 3)
                                                     5 autonomous Circle-wallet bots
```

- **Engine** = the backend brain: every ~2s Arc block it reads on-chain state, computes funding +
  margin/decrement (§4.3), pushes a fresh Stork mark (BTC/XAU) before each checkpoint, and writes the
  authoritative `checkpoint` on-chain. Serves REST + a WebSocket stream.
- **Dashboard** = read-only observability (Next.js). Visualizes the per-block loop the judges watch.
- **Agents** = 5 autonomous bots (long / short / mm / funding / dark), each signing through its own
  **Circle MPC wallet** — no human in the loop, the "agent-to-agent" claim made literal.

---

## One-time prep (already done — verify only)

```bash
bun install                    # deps (only if you haven't)
git rev-parse --short HEAD     # confirm you're on the right commit
```

`.env` is already filled (Circle creds + wallet ids, Chainlink/Stork keys, the 4-market `MARKETS`).
Confirm the live set:

```bash
grep -E '^MARKETS=|^ORACLE_SOURCE' .env
# MARKETS=ETH-PERP,LINK-PERP,BTC-PERP,XAU-PERP
# ORACLE_SOURCE=chainlink ; ORACLE_SOURCE_BTCPERP=stork ; ORACLE_SOURCE_XAUPERP=stork
```

---

## Terminal 1 — the ENGINE (backend, start FIRST)

```bash
# The public Arc RPC handles 4 markets without rate-limiting (Alchemy free-tier 429s under load).
ALCHEMY_ARC_RPC_URL= ARC_RPC_URL=https://rpc.testnet.arc.network bun run engine
```

Wait ~15s for it to subscribe to Arc blocks. **What to point at:** the per-block log lines —
`checkpoint #N @ $… (M accts)` (the on-chain §4.3 settlement firing) and
`pushed Stork mark (BTCUSD/XAUUSD)` (the venue keeping its own marks fresh on-chain).

**Prove it's reading real oracles** (run in any spare terminal):

```bash
curl -s localhost:8787/venue | bun -e 'const d=await Bun.stdin.json(); for(const m of d.markets) console.log(m.symbol.padEnd(10), m.oracle.source, m.live.markProvenance, "$"+m.live.mark)'
```

Expected — all 4 markets, **real on-chain marks**, two oracles:

```
ETH-PERP   chainlink  chainlink-live      $1675.04
LINK-PERP  chainlink  chainlink-live      $7.91
BTC-PERP   stork      stork-live          $64450.00
XAU-PERP   stork      stork-live          $4218.34
```

> **Say to judges:** "Every mark is a real on-chain oracle value — ETH and LINK delivered by a
> **Chainlink CRE workflow**, BTC and gold by **Stork**, behind one pluggable adapter. No mocks."

---

## Terminal 2 — the DASHBOARD (frontend)

```bash
bun run web        # Next.js on http://localhost:3000  (reads the engine at :8787 by default)
```

Open **http://localhost:3000**. It live-streams the engine over WebSocket: pool capital vs cap, the
funding rate moving, the per-block margin-call settlement stream, agent positions, the gap fund.

> **Say to judges:** "This is read-only — agents don't need eyes, they have the API. This visualizes the
> per-block loop a human venue structurally can't run."

---

## Terminal 3 — the AGENTS (the autonomous fleet)

The 5 agents' Circle wallets are already funded + onboarded. Run the scripted scenario — it seeds all
4 pools (from the funding-role Circle wallet) then starts the bots:

```bash
bun run demo
```

**What to point at:** the narration — agents opening/closing, the **MM taking the balancing side so skew
self-corrects**, the **dark agent going silent → decrementing smoothly (no liquidation)**, margin calls
answered as **gas-free x402 Gateway nanopayments**. Cross-reference Terminal 1 (checkpoints) and the
dashboard (the same events, visualized).

> **Say to judges:** "Five autonomous agents, each signing through a **Circle developer-controlled MPC
> wallet** — no private keys in the process, no human clicking. They settle funding + margin calls every
> block as sub-cent Gateway nanopayments, and a position that stops paying just *decrements* — we never
> liquidate."

Single agent instead of the whole scenario: `bun run agent:funding` (the hero) or `agent:dark`.

---

## Terminal 4 (OPTIONAL) — keep the Chainlink marks fresh

A Chainlink mark only updates when the CRE workflow runs (only the DON's forwarder may write it — the
engine can't, by design). To keep ETH/LINK ticking live during a long demo:

```bash
cd packages/cre && ./refresh-marks.sh 60      # re-pushes ETH + LINK via CRE every 60s
```

(BTC/XAU don't need this — the engine pushes their Stork marks inline before each checkpoint.)

> **Say to judges:** "This is the real Chainlink path — a CRE workflow on the DON fetches a Data Streams
> price, reaches consensus, and the **KeystoneForwarder writes it into our contract on Arc**. That
> on-chain write is the qualifying Chainlink integration."

---

## Order + teardown

1. **Terminal 1 (engine)** — start first, wait ~15s.
2. **Terminal 2 (dashboard)** — open the browser.
3. **Terminal 3 (agents)** — `bun run demo`.
4. *(optional)* **Terminal 4** — `refresh-marks.sh`.

**Stop everything:** `Ctrl-C` in each terminal. If a port stays busy:

```bash
lsof -ti tcp:8787 | xargs kill    # engine
lsof -ti tcp:3000 | xargs kill    # dashboard
```

---

## If something looks off (quick fixes)

- **A market shows `synthetic-fallback` instead of live** — the on-chain mark is stale. For ETH/LINK run
  Terminal 4 (CRE re-push); for BTC/XAU the engine self-heals on its next checkpoint push (~10s). Synthetic
  is the labeled safety net, never silent.
- **`reconcile error: HTTP request failed`** — you're on the rate-limited Alchemy RPC. Restart the engine
  with the `ALCHEMY_ARC_RPC_URL= ARC_RPC_URL=https://rpc.testnet.arc.network` prefix (Terminal 1 above).
- **An agent open reverts (`OICapExceeded` / estimation error)** — a pool is over its OI cap. Re-run
  `bun run demo` (it re-seeds), or raise `POOL_SEED_USDC=30 bun run demo`. Refused longs are the venue's
  admission control working, not a bug.
- **Agent has no funds** — it simply doesn't trade (deposit/open reverts, logged). Fund its Circle wallet
  address (see `.env` comments) and re-run `bun run fund`.

---

## The 60-second pitch order for judges

1. **Terminal 1** → "real on-chain marks, 2 oracles (Chainlink CRE + Stork), 4 markets."
2. **Dashboard** → "the per-block loop made visible — funding streaming, no candlesticks."
3. **Terminal 3** → "5 autonomous Circle-wallet agents; the dark one decrements instead of liquidating."
4. **Terminal 4 / a contract read** → "the Chainlink CRE forwarder writes the mark on-chain — the
   qualifying integration; Circle Gateway nanopayments settle every block."
