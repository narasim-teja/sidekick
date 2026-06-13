# @sidekick/mcp

The **SideKick venue as an MCP server**. Every capability of [`@sidekick/sdk`](../sdk) is exposed as
an [MCP](https://modelcontextprotocol.io) tool, so any MCP client — Claude Desktop, the Claude API
agent loop, an IDE — can **discover, onboard, trade, read live state, and answer margin calls** on
SideKick purely by calling tools. This is the literal "agent-native" surface: an LLM trades perps with
no SDK code of its own.

## Tools

| Tool | Does |
|---|---|
| `sidekick_venue` | Self-describe the venue (markets, params, addresses, cadence, units, live snapshot) — call first |
| `sidekick_whoami` | This agent's address + chain |
| `sidekick_state` | Live per-block state for a market (or all): mark, skew, funding, OI, positions, pool, settlement |
| `sidekick_account` | This agent's position + equity + free collateral + owed margin-call shortfall in a market |
| `sidekick_onboard` | Deposit Vault collateral and/or a Circle Gateway balance |
| `sidekick_deposit` / `sidekick_withdraw` | Move collateral between wallet and Vault |
| `sidekick_open` / `sidekick_close` | Open (by leverage or notional) / close a position |
| `sidekick_provide_liquidity` | Provide liquidity to a market's pool (mint slpUSDC) |
| `sidekick_answer_margin_call` | Answer an open margin call as a gas-free Circle Gateway x402 nanopayment |

All amounts are decimal USDC strings. One position per market (close to flip). Missing a margin call
is safe — the venue decrements the position smoothly instead of liquidating. See
[`../../AGENTS.md`](../../AGENTS.md) for the full data model.

## Run

The server signs with one account (`SIDEKICK_PRIVATE_KEY`, a funded Arc-testnet EOA — USDC is the gas
token) and talks to the engine at `ENGINE_URL` (default `http://localhost:8787`).

```bash
SIDEKICK_PRIVATE_KEY=0x... bun run src/index.ts     # or, from the repo root: bun run mcp
```

## Configure in an MCP client

Point the client at this server over stdio, with the key in its env. Example (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sidekick": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/sidekick/packages/mcp/src/index.ts"],
      "env": {
        "SIDEKICK_PRIVATE_KEY": "0x...",
        "ENGINE_URL": "http://localhost:8787"
      }
    }
  }
}
```

Then ask the model things like *"describe the SideKick venue,"* *"onboard with 20 USDC collateral and
5 to Gateway,"* *"open a 10 USDC 5x long on the market with the best funding,"* or *"check my account
and answer any margin call."*

> Keep the private key in the MCP client's env, never in a tool argument. stdout is the JSON-RPC
> channel; the server logs to stderr only.

## Tests

`bun test src` — drives every tool through an in-memory MCP client↔server pair with a faked SDK,
asserting each tool maps to the right call and the schemas reject bad input. No network or key needed.
