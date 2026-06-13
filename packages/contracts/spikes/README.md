# Phase 0 spike tests

Three throwaway spikes that de-risk the external unknowns before any real venue code is built
on top of them. Each answers a question that, if wrong, changes the architecture. **All three
pass live on Arc Testnet** (chain `5042002`).

Run from the repo root with a funded `PRIVATE_KEY` in `.env`:

```bash
bun run spike:arc      # A — Arc deploy + USDC gas + WSS read-back
bun run spike:oracle   # B — oracle mark read via the pluggable adapter (Stork)
bun run spike:gateway  # C — Gateway nanopayment round-trip (@circle-fin/x402-batching)
```

---

## Spike A — Arc deploy + USDC gas + WSS read-back ✓ PASS

Deploys the trivial [`Ping`](../src/spikes/Ping.sol) contract, pays gas in USDC, subscribes
to its event over WSS, sends a tx, and reads the value back.

**Result:** Foundry + viem work unmodified against Arc. Deploy cost ≈ **0.0021 USDC** in gas
(USDC is the native gas token, 18 decimals). The WSS subscription fired with the per-block
`Pinged` event, and `value()` read back correctly. Confirms tooling, the USDC-gas flow, and
that WSS subscriptions deliver per-block — the heartbeat the engine + dashboard hang off of.

## Spike B — Oracle mark read on-chain (pluggable adapter) ✓ PASS

Deploys [`StorkAdapter`](../src/oracle/StorkAdapter.sol) (an implementation of the common
[`IOracleAdapter`](../src/oracle/IOracleAdapter.sol)) per market and reads the mark on-chain
through that one interface.

**Result:** the pluggable adapter reads a live Stork mark on-chain — **BTCUSD ≈ $70,627**,
normalized to 18 decimals. Two findings worth carrying forward:

- **Asset-id encoding verified:** `keccak256(utf8(symbol))` matches the Stork registry exactly
  for all five SideKick assets (BTC/ETH/SOL/LINK/HYPE). So `storkAssetId()` in
  `@sidekick/shared` is correct and needs no per-asset literals.
- **Testnet feed coverage:** only **BTCUSD** is currently pushed on Arc **testnet**; ETH/SOL/
  LINK/HYPE have valid ids but revert `NotFound` (no value pushed), and the BTC value is stale
  (~124 days). The encoding is right; coverage is the gap. **Implication:** for non-BTC
  markets on testnet, the venue must push a fresh signed Stork update (the pull path,
  `updateTemporalNumericValuesV1`) before reading — the read-only `Unsafe` getter alone
  returns nothing. The freshness-checked getter is what production uses.

The **Chainlink** leg of the adapter is confirmed Day-1 once Data Feeds/Streams addresses on
Arc are known; this spike proves the adapter shape end-to-end with the Stork implementation.

## Spike C — Gateway nanopayment round-trip ✓ PASS (the keystone spike)

Resolves the single most important Layer B question. Circle ships the official
**`@circle-fin/x402-batching`** SDK; its `GatewayClient` treats **`arcTestnet` as a
first-class chain** (Gateway domain 26).

**Result:** the GatewayClient connected to Arc, deposited **0.5 USDC**, and the Gateway
**unified balance went 0 → 0.5** (one approval tx + one deposit tx). Findings:

- **No raw burn/mint fallback needed** — the SDK path is callable on Arc testnet. The Layer B
  design rests on `GatewayClient` (`deposit`, `getBalances`, `pay`), not hand-built contracts.
- **The off-chain authorization is EIP-3009** `TransferWithAuthorization` (the x402 protocol),
  signed inside the SDK — *not* a hand-rolled "EIP-712 burn intent" (docs corrected).
- **Arc quirk:** the wallet's USDC-as-gas balance and the Gateway USDC ERC-20 are the **same
  token** — faucet USDC funds both gas and Gateway deposits; no separate ERC-20 funding step.

The per-payment `pay()` authorization targets an x402 *resource (seller)* endpoint, which the
engine provides in Phase 3; this spike proves the **deposit + unified-balance precondition**
that every gas-free nanopayment draws against.

---

## Fallbacks (documented, architecture-neutral)

- **Gateway (C):** if the SDK ever stops working on Arc, run the per-block ledger in the engine
  against Gateway unified balances and batch-settle via the raw burn/mint contracts (Gateway
  Wallet `0x0077…19B9`, Minter `0x0022…475B`, domain 26) using EIP-3009 directly. Only the
  Circle surface called changes; the three-layer architecture does not.
- **Oracle (B):** if a market's asset is not pushed on Arc, either push a fresh Stork update
  first (pull path) or set that market's adapter to **Chainlink** via `chainlinkOracle()` —
  the `IOracleAdapter` interface makes the source swappable per-market.
- **Engine cadence (A):** if the per-block loop ever falls behind 2s blocks, reconcile every N
  blocks instead of every block — a smooth degradation, no architectural change.

These spikes are intentionally throwaway: the point was to learn, and the learnings are
captured above and folded into `@sidekick/shared`.
