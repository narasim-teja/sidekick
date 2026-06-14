# @sidekick/web — landing + observability dashboard (Phase 7)

The human-facing web app. Next.js 15 (App Router, static export) + Tailwind v4 + three.js,
one "mission-control" visual identity across **two routes**:

| Route | Surface | What it is |
| --- | --- | --- |
| `/` | **Landing** (marketing) | The agent-native perp thesis, the per-block loop explained, and the **SDK install** on-ramp (`@sidekick/sdk`, npm/pnpm/bun/yarn). A bespoke, self-running three.js **settlement-lattice** hero. CTA → `/dashboard`. |
| `/dashboard` | **Dashboard** (read-only) | The per-block loop made visible — **not** a candlestick trading chart. The live instrument panel. |

The dashboard hero is a **three.js settlement network**: a central pool node ringed by the
live agent nodes, with every settlement event flying between them as a colored **packet** — the
"thousands of sub-cent payments per block" claim made literal. Magenta packets are the x402
Gateway **nanopayment** (the headline), amber is the funding stream, cyan is an in-checkpoint
auto-settle. The landing's lattice hero is a separate, self-running dramatization of the same
idea (`src/components/landing/LatticeHero.tsx`).

## Panels (Doc 2 §7.1)

- **Hero** — the 3D settlement network + the funding-strategy "hero" and dark-agent statuses.
- **Market** — live mark, the convex funding curve `clamp(α·S·|S|, ±r_max)` with the live skew
  marked on it, exposure-vs-the-Layer-2-cap gauge, OI long/short.
- **Settlement stream** — the per-block nanopayment console, the three `kind`s labelled
  distinctly so the Gateway nanopayment reads apart from internal contract moves.
- **Positions** — each agent's position, margin status, and the live **decrement** (the
  no-liquidation proof: `N′ = E / m`, a smooth trim toward zero, never a cliff).
- **Pool health** — pool capital / LP claim value as the **stable headline**, with settlement
  flow shown **separately** (Ostium-style, so operational swings are never read as PnL).
- **Agents** — each demo agent's role, strategy, and Arcscan-linked identity.

## Data source — live engine, with a graceful replay fallback

The dashboard is a pure client of the engine's REST + WebSocket surface
(`packages/engine`). It:

1. Bootstraps from `GET /state` + `/status` + `/venue`, then subscribes to `/ws` for the
   per-block `{type:"block", state}` push.
2. If the engine is unreachable within ~2.5s, it transparently falls back to a **deterministic
   demo replay** — a faithful in-browser model of the venue math (the §4.1 convex funding,
   §4.2 decrement, conservation) that follows the Doc 3 §11 demo arc. A cold URL is **never
   blank**; the mode is badged `LIVE` / `REPLAY` in the header.

There is one source of truth (the feed); every panel reads it. The browser bundle pulls in no
server packages — the engine's payload types are mirrored locally in `src/lib/types.ts`.

## Run

```bash
# from the repo root, with the engine running for LIVE data:
bun run engine          # packages/engine — the live per-block loop (REST :8787 + /ws)
bun run demo            # packages/agents — drives the five demo agents (optional)

# the web app:
cd apps/web
bun run dev             # http://localhost:3000        — the landing page
                        # http://localhost:3000/dashboard — the instrument panel
```

With no engine running, `/dashboard` still shows the full panel in **REPLAY** mode. The landing
page at `/` is fully static and needs no engine.

## Configuration (env)

All `NEXT_PUBLIC_*` and inlined at build time (static export):

| Var | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_ENGINE_URL` | `http://localhost:8787` | Engine REST base. |
| `NEXT_PUBLIC_ENGINE_WS` | derived from the URL (`http→ws` + `/ws`) | WS stream URL. |
| `NEXT_PUBLIC_AGENTS` | — | JSON `{address: role}` map to label the live (Circle-wallet) fleet by role. Absent it, the replay-fixture demo addresses are still labelled out-of-the-box. |

## Deploy (Vercel or any static host)

The app is a **static export** (`output: "export"` → `out/`), so it deploys anywhere:

```bash
bun run build           # → apps/web/out (static)
# Vercel: set the project root to apps/web; framework "Next.js"; it serves the export.
```

For a hosted deploy, set `NEXT_PUBLIC_ENGINE_URL` (and `NEXT_PUBLIC_ENGINE_WS`) to your hosted
engine. Until the engine is hosted, a deployed URL runs in REPLAY mode — still a complete,
self-contained demo.

## Notes

- **WebGL fallback.** If WebGL can't initialize (headless capture, locked-down GPU), the hero
  falls back to an SVG version of the same network — never a blank or broken panel.
- **No hydration risk.** Live data is client-only; the data grid renders behind a `mounted`
  gate so SSR and the first client render agree.
- Source of truth for the data contract: `packages/engine/src/state.ts` (mirrored in
  `src/lib/types.ts`). Re-mirror if the engine payload changes shape.
