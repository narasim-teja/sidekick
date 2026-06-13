# @sidekick/web — observability dashboard (Phase 7)

The human-facing, **read-only** dashboard. It visualizes the per-block loop made visible —
**not** a candlestick trading chart.

Built in **Phase 7** (Next.js + Tailwind + shadcn/ui), live against testnet via the engine's
WebSocket stream. Panels (Doc 2 §7.1):

- **Per-market:** live mark, skew-vs-cap gauge, funding rate (convex curve), OI long/short.
- **Settlement stream:** the per-block margin-call + funding nanopayments firing, agent ↔ pool.
- **Positions table:** each agent's position, margin status, live decrement when the dark agent goes silent.
- **Pool health:** pool capital / LP claim value as the **stable headline**, with live settlement
  flow shown **separately and clearly labeled** (Ostium-style, so operational swings ≠ PnL).
- **Agent view:** each demo agent's ERC-8004 identity, strategy, and activity.

The hero screen: the funding-strategy agent holding pure funding exposure + the dark agent
decrementing smoothly — the two visuals that prove the thesis.

This directory is an intentional placeholder until Phase 7 to avoid premature dependency drift;
`next` is initialized here when the dashboard work begins.
