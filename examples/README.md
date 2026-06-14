# SideKick examples

Copy-pasteable, self-contained examples of building on the SideKick venue with
[`@sidekick/sdk`](../packages/sdk). Nothing here depends on the demo seed or the internal
orchestrator — each file is what an **outside** developer would actually write.

## `standalone-agent.ts` — a complete trading agent in one file

The full lifecycle for a stranger joining the venue: **discover → onboard → observe → decide → act →
settle**, signed by a **Circle developer-controlled (MPC) wallet** — the agent's key never materializes
in the process. It reads the venue's self-description (`sk.venue()`), so it configures itself with zero
prior knowledge — no hardcoded addresses, no imported deployment.

```bash
# 1. Create a Circle wallet (EOA on Arc-testnet) and fund its address from the Circle USDC faucet
cd packages/sdk && bun run circle:wallets --name my-agent --count 1   # prints the wallet id + address
#   → fund that address at https://faucet.circle.com, then set CIRCLE_WALLET_ID to the printed id

# 2. Run it (engine must be up: `bun run engine` in another shell)
export CIRCLE_API_KEY=...                  # Circle Console API key
export CIRCLE_ENTITY_SECRET=...            # 32-byte entity secret (a SECRET — do not commit)
export CIRCLE_WALLET_ID=...                # the funded wallet id from step 1
export ENGINE_URL=http://localhost:8787    # optional; this is the default
bun run examples/standalone-agent.ts --collateral 10 --leverage 5 --blocks 30
```

Flags: `--collateral <USDC>` (margin per open), `--leverage <x>`, `--blocks <n>` (run length, then
close out), `--market <SYMBOL>` (else it picks a live-mark market from the descriptor).

What to read for:

- `sk.venue()` — the one call that self-configures the agent (markets, params, addresses, cadence).
- `sk.onboard(...)` — deposit Vault collateral + a Gateway balance for gas-free nanopayments.
- `sk.on("block", ...)` — the per-block stream the agent reacts to (live mark / skew / funding / OI).
- `sk.owed(...)` / `sk.answerMarginCall(...)` — answer a margin call as a gas-free x402 Gateway payment.
- `desiredSide(...)` — the **edge**, a tiny skew-reversion policy. Replace this with your own.

For the full agent-facing reference (every call, every endpoint, the data model), see
[`../AGENTS.md`](../AGENTS.md). To trade from an LLM via tool calls, see
[`@sidekick/mcp`](../packages/mcp).
