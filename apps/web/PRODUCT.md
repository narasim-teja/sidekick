# Product

## Register

brand

> Note: this app has two surfaces with two registers. The **landing page** (`/`) is a *brand*
> surface — its job is to make the thesis land and get an agent developer to `bun i @sidekick/sdk`.
> The **dashboard** (`/dashboard`) is a *product* surface — a read-only observability instrument
> panel. They share one visual identity (DESIGN.md) but the landing leads.

## Users

Two audiences, one page each:

- **Landing (`/`)** — hackathon judges and agent/quant developers. A judge skims for the thesis
  in 60 seconds; a developer wants to know what the SDK does and how to install it. Both are
  technical, skeptical, and allergic to marketing fluff. They reward a precise mechanical claim
  and punish a vague one.
- **Dashboard (`/dashboard`)** — the same people, plus the autonomous agents' operators, watching
  the per-block loop run live. Context: a second monitor during a demo, or a deep-dive after the
  pitch. They are reading numbers, not buying.

## Product Purpose

SideKick is a perpetual-futures venue built for AI agents instead of humans. It deletes the three
human-era assumptions in a perp — discrete 8h funding, threshold liquidation with penalty, static
order books — and rebuilds them for participants that respond every block: per-block continuous
funding, no liquidations (smooth decrement instead), gas-free nanopayment settlement on Arc.

The landing page's success is a developer who understands the thesis and copies the install command.
The dashboard's success is a judge who watches the per-block loop and believes it is real.

## Brand Personality

Three words: **mechanical, exact, unflinching.** This is instrument-room engineering, not a
fintech brochure. The voice states a precise claim and the mechanism behind it, names its own
weakness before being asked, and never reaches for a superlative when a number will do. It reads
like the readout on a machine built for other machines to watch.

## Anti-references

- **SaaS-cream / soft-gradient fintech landing pages.** Rounded pastel cards, a hero metric in a
  giant gradient number, three identical feature cards with rounded-square icons. The modal
  crypto-startup look. Avoid entirely.
- **Candlestick / trading-chart UI.** This is explicitly *not* a trading venue for humans; a price
  chart would mis-sell it. No charts that look like TradingView.
- **Editorial-magazine brand template.** Display-serif italic headline + tiny tracked mono eyebrows
  over every section + ruled three-column grid. The saturated "AI-tasteful" landing lane.
- **Generic dark-mode dev-tool landing.** Purple-to-blue gradient hero, "Build faster" headline,
  logo cloud. Indistinguishable from 500 other tools.

## Design Principles

1. **The mechanism is the marketing.** Lead with the exact claim (per-block funding, smooth
   decrement, sub-cent settlement) and show the math or the live readout. Never abstract it into
   a benefit-bullet. A skeptic should be able to verify, not just nod.
2. **Honest provenance, always.** LIVE vs REPLAY is labelled. Synthetic marks are labelled. The
   landing should never imply more than is built; the docs' own honest caveat is a feature.
3. **One identity across both surfaces.** The landing and the dashboard are the same machine seen
   from two distances. The hero packet-network, the phosphor palette, the hairline panels, the
   monospace numbers — continuous from marketing to instrument.
4. **The reader is an agent's author.** Copy talks to someone who will paste a private key and an
   engine URL and let a program trade. Show real SDK calls, real package names, real lifecycles —
   not "sign up" CTAs.
5. **Restraint is signal, not safety.** The palette is committed and asymmetric (one dominant
   graphite, signal accents that each *mean* something). Color is used to encode — long/short,
   funding, nanopayment, pool — never to decorate.

## Accessibility & Inclusion

- WCAG AA for all body text (≥4.5:1) against the near-black panels; large display ≥3:1. The
  phosphor-green and amber signals must clear contrast on `--bg`, not just look bright.
- Every animation (packet hero, scanlines, reveals, pulse) has a `prefers-reduced-motion: reduce`
  alternative — the existing `globals.css` already does this; new motion must too.
- Keyboard-reachable CTAs and the package-manager tab control; visible focus states.
- The 3D hero must never gate content: a 2D SVG fallback already exists for no-WebGL contexts, and
  text must read without it.
