# @sidekick/contracts

The Foundry project: all SideKick Solidity (Phase 2 venue contracts) plus the Phase 0 spike
contracts and their TypeScript runners.

## Layout

```
src/
  spikes/Ping.sol          # Spike A — trivial deploy/read/event contract (throwaway)
  oracle/IOracleAdapter.sol # pluggable oracle adapter interface (on-chain half)
  oracle/StorkAdapter.sol   # Stork implementation of IOracleAdapter (Spike B)
spikes/                    # TypeScript spike runners (viem + Bun)
lib/
  forge-std/               # reinstallable (NOT committed) — see below
  openzeppelin-contracts/  # reinstallable (NOT committed) — see below
  stork-evm-sdk/           # vendored & committed (authoritative Stork interface, 5 files)
```

## Dependencies (reinstall after a fresh clone)

`lib/forge-std` and `lib/openzeppelin-contracts` are reinstallable third-party deps and are
**git-ignored** to keep the repo lean. After cloning, restore them with pinned versions:

```bash
cd packages/contracts
forge install foundry-rs/forge-std@v1.16.1 --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 --no-git
```

`lib/stork-evm-sdk` IS committed (vendored from npm `@storknetwork/stork-evm-sdk@1.0.5`) — it is
the authoritative Stork interface the oracle adapter imports, and small enough to keep in-tree so
the contracts build with no extra fetch.

Remappings live in `foundry.toml`.

## Build & test

```bash
forge build      # or: bun run --filter @sidekick/contracts build
forge test
forge fmt
```

## Spikes (Phase 0)

Run from the repo root with a funded `PRIVATE_KEY` in `.env`:

```bash
bun run spike:arc      # Spike A — Arc deploy + USDC gas + WSS read-back
bun run spike:oracle   # Spike B — oracle mark read via the pluggable adapter (Stork)
bun run spike:gateway  # Spike C — Gateway nanopayment round-trip (@circle-fin/x402-batching)
```

See [spikes/README.md](spikes/README.md) for what each confirms and the latest results.
