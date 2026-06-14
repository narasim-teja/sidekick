"use client";

/**
 * Landing: the marketing page at `/`. It is the brand surface: make the agent-native perp thesis
 * land in 60 seconds and get a developer to install the SDK. Five movements, each a different visual
 * world but one continuous identity (the dashboard's instrument-panel language at brand scale):
 *
 *   1. HERO      , the self-running settlement-lattice (bespoke three.js) + the one-breath claim + CTAs.
 *   2. THESIS    , the three human-era assumptions SideKick deletes, stated as before → after.
 *   3. MECHANISM , the per-block loop made legible: mark → fund → check → call → settle → decrement.
 *   4. SDK       , the developer on-ramp: the install console + a real, copyable agent lifecycle.
 *   5. STACK     , what it runs on (Arc / Circle / Chainlink) + the closing "enter the venue" CTA.
 *
 * The lattice hero is dynamically imported with SSR off (three.js needs the DOM); a static gradient
 * shows until it mounts and if WebGL is unavailable, so the headline always reads.
 */

import dynamic from "next/dynamic";
import { useState } from "react";
import { InstallConsole } from "./InstallConsole.tsx";
import { LandingNav } from "./LandingNav.tsx";
import { useReveal } from "./useReveal.ts";

const LatticeHero = dynamic(
  () => import("./LatticeHero.tsx").then((m) => m.LatticeHero),
  { ssr: false },
);

export function Landing() {
  return (
    <main id="top" className="relative blueprint">
      <LandingNav />
      <Hero />
      <Thesis />
      <Mechanism />
      <Sdk />
      <Stack />
      <FooterCta />
    </main>
  );
}

/* ── 1. HERO ─────────────────────────────────────────────────────────────────────────────────── */

function Hero() {
  const [webglFailed, setWebglFailed] = useState(false);
  return (
    <section className="relative min-h-[100svh] flex items-center overflow-hidden">
      {/* Static palette backdrop (also the pre-mount / no-WebGL fallback), full-bleed, behind all. */}
      <div
        className="absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(820px 620px at 72% 46%, rgba(87,199,255,0.10), transparent 62%), radial-gradient(620px 520px at 66% 78%, rgba(255,82,217,0.07), transparent 60%)",
        }}
      />
      {/* The lattice canvas. On wide viewports it occupies the RIGHT portion of the hero (a counterweight
          to the left-aligned headline); on narrow ones it sits behind the content, full-bleed + dimmed. */}
      <div className="absolute inset-0 z-0 lg:left-[42%]" style={{ opacity: 1 }}>
        {!webglFailed && <LatticeHero onUnsupported={() => setWebglFailed(true)} />}
      </div>
      {/* readability scrim, heavy on the left, clears to the right where the lattice lives */}
      <div
        className="absolute inset-0 z-[1] pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, rgba(7,9,12,0.94) 0%, rgba(7,9,12,0.72) 34%, rgba(7,9,12,0.18) 62%, transparent 80%)",
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-40 z-[1] pointer-events-none"
        style={{ background: "linear-gradient(0deg, var(--bg), transparent)" }}
      />

      <div className="relative z-10 mx-auto max-w-[1480px] w-full px-4 sm:px-6 pt-28 pb-16">
        <div className="max-w-3xl">
          <p className="rise font-mono text-[11px] sm:text-[12px] tracking-[0.22em] uppercase text-[var(--fg-dim)] mb-5">
            perpetual futures · built for agents, not humans
          </p>
          <h1 className="rise display-xl" style={{ animationDelay: "60ms" }}>
            The venue that
            <br />
            never <span className="signal-glow">liquidates</span> you.
          </h1>
          <p
            className="rise lede mt-6 text-[15px] sm:text-[17px]"
            style={{ animationDelay: "140ms" }}
          >
            Human perp venues settle funding every 8 hours and force-close you at a penalty, because
            humans are slow. SideKick assumes the opposite. Funding settles{" "}
            <span className="text-[var(--accent-funding)]">every block</span>. Margin reconciles{" "}
            <span className="text-[var(--accent-funding)]">every block</span>. Miss a call and your
            position <span className="text-[var(--fg)]">decrements smoothly</span>, no liquidation,
            no penalty, no keeper. Settled through gas-free{" "}
            <span className="nano-glow">nanopayments</span> on Arc.
          </p>

          <div className="rise mt-9 flex flex-wrap items-center gap-3" style={{ animationDelay: "220ms" }}>
            <a href="/dashboard" className="btn-key text-[0.92rem] px-5 py-3">
              Watch it run live
              <span aria-hidden="true">↗</span>
            </a>
            <a href="#sdk" className="btn-ghost text-[0.92rem] px-5 py-3">
              Install the SDK
            </a>
          </div>

          {/* The three claims as a tight readout strip, not three cards. */}
          <dl
            className="rise mt-12 grid grid-cols-1 sm:grid-cols-3 gap-px max-w-2xl border border-[var(--line)] rounded overflow-hidden"
            style={{ animationDelay: "300ms", background: "var(--line)" }}
          >
            <Claim k="funding cadence" v="every block" sub="vs every 8 hours" accent="var(--accent-funding)" />
            <Claim k="liquidations" v="zero" sub="smooth decrement instead" accent="var(--signal)" />
            <Claim k="settlement" v="sub-cent" sub="off-chain, gas-free" accent="var(--accent-nano)" />
          </dl>
        </div>
      </div>

      {/* scroll cue */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 text-[var(--fg-dim)] text-[10px] tracking-[0.25em] uppercase flex flex-col items-center gap-2">
        <span>scroll</span>
        <span className="block w-px h-8 bg-gradient-to-b from-[var(--line-bright)] to-transparent" />
      </div>
    </section>
  );
}

function Claim({
  k,
  v,
  sub,
  accent,
}: {
  k: string;
  v: string;
  sub: string;
  accent: string;
}) {
  return (
    <div className="bg-[var(--bg-panel)] px-4 py-4">
      <div className="eyebrow">{k}</div>
      <div className="font-display font-bold text-2xl mt-1.5" style={{ color: accent }}>
        {v}
      </div>
      <div className="text-[11px] text-[var(--fg-dim)] mt-0.5">{sub}</div>
    </div>
  );
}

/* ── 2. THESIS ───────────────────────────────────────────────────────────────────────────────── */

const DELETED = [
  {
    n: "01",
    assumption: "Discrete funding, every 8 hours",
    why: "You can't ask a human to reconcile a cashflow every few seconds, so venues batch it, and traders game the snapshot.",
    instead: "Per-block continuous funding",
    detail:
      "The rate recomputes each block from live book skew and settles as a stream. No snapshot to game. Holding one block costs exactly one block of funding, so funding becomes a clean tradeable signal an agent can hold in isolation.",
    accent: "var(--accent-funding)",
  },
  {
    n: "02",
    assumption: "Threshold liquidation, with a penalty",
    why: "A human can't answer a margin call in 200ms, so the venue force-closes the position at a penalty and pays a keeper to do it.",
    instead: "Continuous reconciliation, no liquidation",
    detail:
      "Every block we mark, compute the shortfall, and request it as a tiny payment. Pay → healthy. Don't pay → the position decrements by exactly enough to be adequately margined at the current mark. No cliff, no penalty, no keeper network.",
    accent: "var(--signal)",
  },
  {
    n: "03",
    assumption: "Static orders in a book",
    why: "A human's intent is static between decisions, so a passive store of frozen instructions is the right abstraction.",
    instead: "A pool counterparty + agent strategies",
    detail:
      "Traders trade against an isolated USDC pool priced by convex skew-funding; agent market-makers layer on top to earn the rebate crowded-side traders pay. Intent is a function of world state, expressed in code, not a flicker of cancel/replace orders.",
    accent: "var(--accent-mm)",
  },
];

function Thesis() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section id="thesis" className="relative z-10 mx-auto max-w-[1480px] px-4 sm:px-6 py-24 sm:py-32">
      <div ref={ref} className="reveal">
        <SectionHead
          index="A"
          title="Three assumptions, deleted."
          lede="Every human perp venue bakes in three workarounds for human slowness. An agent has none of those limits, so we removed all three. This isn't an SDK bolted on a human venue; it's a different engine and a different risk model."
        />

        <div className="mt-14 flex flex-col">
          {DELETED.map((d, i) => (
            <article
              key={d.n}
              className="group grid grid-cols-1 lg:grid-cols-[auto_1fr_1fr] gap-6 lg:gap-10 py-9"
              style={{ borderTop: i === 0 ? "none" : "1px solid var(--line)" }}
            >
              <div className="flex items-start gap-4 lg:w-44">
                <span
                  className="font-display font-bold text-3xl leading-none"
                  style={{ color: d.accent }}
                >
                  {d.n}
                </span>
              </div>

              {/* before */}
              <div>
                <div className="eyebrow mb-2">human venue</div>
                <h3 className="font-display text-[1.05rem] text-[var(--fg-mid)] line-through decoration-[var(--danger)]/50 decoration-2">
                  {d.assumption}
                </h3>
                <p className="mt-2 text-[13px] text-[var(--fg-dim)] leading-relaxed max-w-sm">
                  {d.why}
                </p>
              </div>

              {/* after */}
              <div>
                <div className="eyebrow mb-2" style={{ color: d.accent }}>
                  sidekick →
                </div>
                <h3 className="display-md text-[1.25rem]" style={{ color: d.accent }}>
                  {d.instead}
                </h3>
                <p className="mt-2 text-[13px] text-[var(--fg-mid)] leading-relaxed max-w-md">
                  {d.detail}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── 3. MECHANISM ────────────────────────────────────────────────────────────────────────────── */

const LOOP = [
  { step: "mark", body: "Re-price every position at the new oracle mark.", accent: "var(--fg)" },
  { step: "fund", body: "Apply this block's funding, convex in skew, smoothed against spikes.", accent: "var(--accent-funding)" },
  { step: "check", body: "Is equity ≥ maintenance? Healthy → done.", accent: "var(--fg-mid)" },
  { step: "call", body: "Else request the shortfall as a margin-call nanopayment.", accent: "var(--accent-nano)" },
  { step: "settle", body: "Paid off-chain via x402 → margin restored.", accent: "var(--accent-pool)" },
  { step: "decrement", body: "Unpaid → shrink to maintenance-adequate. No liquidation.", accent: "var(--signal)" },
];

function Mechanism() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section
      id="mechanism"
      className="relative z-10 border-y border-[var(--line)]"
      style={{
        background:
          "linear-gradient(180deg, rgba(87,199,255,0.03), transparent 30%, rgba(255,82,217,0.03))",
      }}
    >
      <div className="mx-auto max-w-[1480px] px-4 sm:px-6 py-24 sm:py-32">
        <div ref={ref} className="reveal">
          <SectionHead
            index="B"
            title="One loop, every two seconds."
            lede="No part of this is theoretical batching. Every Arc block (~2s) the engine runs one deterministic pass over every position. The order is load-bearing, mark, then fund, then check post-funding equity, then decrement on that equity. Watch it on the dashboard."
          />

          {/* the loop as a horizontal pipeline of stages connected by the flowing nano-line */}
          <div className="mt-14">
            <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-px bg-[var(--line)] border border-[var(--line)] rounded overflow-hidden">
              {LOOP.map((s, i) => (
                <li key={s.step} className="relative bg-[var(--bg-panel)] p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <span
                      className="font-mono text-[11px] tabular-nums"
                      style={{ color: "var(--fg-dim)" }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="rule-line flex-1" />
                  </div>
                  <h3
                    className="font-display font-semibold text-[1.05rem] mb-1.5"
                    style={{ color: s.accent }}
                  >
                    {s.step}
                  </h3>
                  <p className="text-[12px] text-[var(--fg-mid)] leading-relaxed">{s.body}</p>
                </li>
              ))}
            </ol>
            <div className="flowline mt-px" aria-hidden="true" />
            <p className="mt-4 text-[11px] text-[var(--fg-dim)] font-mono">
              {"// thousands of sub-cent payments flow through this loop, every block, with zero gas."}
            </p>
          </div>

          {/* the honest caveat, volunteered, per the docs */}
          <div className="mt-12 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-center border border-[var(--line-bright)] rounded p-6 bg-[var(--bg-panel)]">
            <p className="text-[13px] text-[var(--fg-mid)] leading-relaxed max-w-2xl">
              <span className="text-[var(--fg)] font-semibold">The honest edge.</span> Decrement
              handles <em>gradual</em> trouble. A single-block price gap that jumps a position from
              solvent to underwater has no in-between to decrement through, so a small{" "}
              <span className="text-[var(--fg)]">gap fund</span> remains, sized only for gaps, an
              order of magnitude smaller than a normal insurance fund. We name our own weakness
              before you ask.
            </p>
            <a href="/dashboard" className="btn-ghost shrink-0">
              See the loop on the dashboard
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── 4. SDK ──────────────────────────────────────────────────────────────────────────────────── */

const LIFECYCLE = `import { SideKick } from "@sidekick/sdk";

const sk = new SideKick({ privateKey, engineUrl });

// 1 · DISCOVER, the venue self-configures the agent
const venue = await sk.venue();

// 2 · ONBOARD, collateral in the Vault + a Gateway balance
await sk.onboard({ collateral: "100" });

// 3 · OPEN, one position, levered against the pool
await sk.open({ market: "ETH-PERP", side: "long", leverage: 5 });

// 4 · EACH BLOCK, answer the margin call, gas-free
sk.onBlock(async (state) => {
  if (await sk.owed("ETH-PERP")) {
    await sk.answerMarginCall("ETH-PERP"); // x402 nanopayment
  }
  // ...miss it and the venue decrements you, no liquidation
});`;

const SDK_DOES = [
  { verb: "read", line: "mark · skew · funding · OI · your account, live per block" },
  { verb: "act", line: "open / close · post / withdraw collateral · provide liquidity" },
  { verb: "settle", line: "answer margin calls as gas-free x402 Gateway nanopayments" },
  { verb: "subscribe", line: "one onBlock handler your agent's whole loop hangs off" },
];

function Sdk() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section id="sdk" className="relative z-10 mx-auto max-w-[1480px] px-4 sm:px-6 py-24 sm:py-32">
      <div ref={ref} className="reveal">
        <SectionHead
          index="C"
          title="Agents have API calls, not eyes."
          lede="There is no trading chart, the product surface is a TypeScript SDK and a per-block event stream. A stranger's agent discovers the venue, onboards, trades, and answers its own margin calls with no human in the loop. The SDK is the venue, from the consumer's point of view."
        />

        <div className="mt-14 grid grid-cols-1 lg:grid-cols-[0.9fr_1.1fr] gap-10 lg:gap-14 items-start">
          {/* left: install + what it does */}
          <div>
            <InstallConsole />

            <ul className="mt-8 flex flex-col divide-y divide-[var(--line)] border-y border-[var(--line)]">
              {SDK_DOES.map((d) => (
                <li key={d.verb} className="flex items-baseline gap-4 py-3">
                  <span
                    className="font-display font-semibold text-[13px] w-20 shrink-0"
                    style={{ color: "var(--signal)" }}
                  >
                    {d.verb}
                  </span>
                  <span className="text-[13px] text-[var(--fg-mid)] leading-relaxed">{d.line}</span>
                </li>
              ))}
            </ul>

            <p className="mt-6 text-[12px] text-[var(--fg-dim)] leading-relaxed">
              Also shipped: an{" "}
              <span className="text-[var(--fg-mid)]">MCP server</span> that exposes the venue as
              tools, so any MCP-capable agent trades with zero bespoke integration. Onboarding
              registers an{" "}
              <span className="text-[var(--fg-mid)]">ERC-8004</span> on-chain agent identity.
            </p>
          </div>

          {/* right: the real lifecycle, as a code window */}
          <div className="console">
            <div className="console-chrome">
              <span className="console-dot" style={{ background: "var(--danger)" }} />
              <span className="console-dot" style={{ background: "var(--warn)" }} />
              <span className="console-dot" style={{ background: "var(--signal)" }} />
              <span className="ml-2 text-[10px] tracking-[0.18em] uppercase text-[var(--fg-dim)]">
                standalone-agent.ts · the full lifecycle
              </span>
            </div>
            <pre className="p-5 overflow-x-auto scroll-thin text-[12.5px] leading-[1.7]">
              <code className="font-mono">{highlight(LIFECYCLE)}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A deliberately tiny syntax tint, not a full tokenizer, just enough to lift comments, strings, and a
 * few keywords so the snippet reads like an editor without pulling in a highlighting dependency. The
 * source string is trusted (a literal above), so splitting on lines and spans is safe.
 */
function highlight(src: string) {
  return src.split("\n").map((line, i) => {
    const key = `l-${i}`;
    if (line.trim().startsWith("//")) {
      const indent = line.length - line.trimStart().length;
      return (
        <span key={key}>
          {" ".repeat(indent)}
          <span style={{ color: "var(--fg-dim)" }}>{line.trim()}</span>
          {"\n"}
        </span>
      );
    }
    // tint quoted strings amber, a few keywords cyan.
    const parts: React.ReactNode[] = [];
    const re = /("[^"]*")|\b(import|from|const|await|async|if|new)\b/g;
    let last = 0;
    let m: RegExpExecArray | null = re.exec(line);
    let idx = 0;
    while (m !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (m[1]) {
        parts.push(
          <span key={`s-${i}-${idx}`} style={{ color: "var(--accent-funding)" }}>
            {m[1]}
          </span>,
        );
      } else {
        parts.push(
          <span key={`k-${i}-${idx}`} style={{ color: "var(--accent-mm)" }}>
            {m[2]}
          </span>,
        );
      }
      last = m.index + m[0].length;
      idx++;
      m = re.exec(line);
    }
    if (last < line.length) parts.push(line.slice(last));
    return (
      <span key={key}>
        {parts}
        {"\n"}
      </span>
    );
  });
}

/* ── 5. STACK + FOOTER ───────────────────────────────────────────────────────────────────────── */

const STACK = [
  {
    name: "Arc",
    role: "Circle's USDC-native L1",
    line: "~2s blocks, sub-second deterministic finality. USDC is the gas token and the collateral. The whole venue settles here.",
    accent: "var(--accent-pool)",
  },
  {
    name: "Circle Gateway",
    role: "gas-free nanopayments",
    line: "x402 / EIP-3009 signed authorizations against a unified balance. Thousands of sub-cent payments per block, the primitive that makes per-block funding viable.",
    accent: "var(--accent-nano)",
  },
  {
    name: "Chainlink CRE",
    role: "verifiable settlement",
    line: "One workflow: pluggable oracle delivery (Stork or Chainlink) feeding periodic batch settlement that posts authoritative state on-chain. BFT-verified, not TEE'd.",
    accent: "var(--signal)",
  },
];

function Stack() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section
      id="stack"
      className="relative z-10 border-t border-[var(--line)] mx-auto max-w-[1480px] px-4 sm:px-6 py-24 sm:py-32"
    >
      <div ref={ref} className="reveal">
        <SectionHead
          index="D"
          title="Built on the rails that just shipped."
          lede="None of this was buildable until months ago. Per-block funding means thousands of sub-cent payments per block, economically impossible until batched nanopayments existed. We're on-time to a newly-buildable solution, not early to a problem."
        />

        <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-px bg-[var(--line)] border border-[var(--line)] rounded overflow-hidden">
          {STACK.map((s) => (
            <div key={s.name} className="bg-[var(--bg-panel)] p-7 flex flex-col">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-2 h-2 rounded-full" style={{ background: s.accent }} />
                <span className="eyebrow">{s.role}</span>
              </div>
              <h3 className="display-md text-[1.4rem]" style={{ color: s.accent }}>
                {s.name}
              </h3>
              <p className="mt-3 text-[13px] text-[var(--fg-mid)] leading-relaxed">{s.line}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FooterCta() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section className="relative z-10 overflow-hidden border-t border-[var(--line)]">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(720px 380px at 50% 120%, rgba(56,249,176,0.10), transparent 60%)",
        }}
      />
      <div ref={ref} className="reveal relative mx-auto max-w-[1480px] px-4 sm:px-6 py-28 sm:py-36 text-center">
        <h2 className="display-lg mx-auto max-w-3xl">
          The per-block loop is{" "}
          <span className="signal-glow">running right now</span>.
        </h2>
        <p className="lede mx-auto mt-5 text-[15px] sm:text-[16px]">
          Watch funding move, the settlement stream fire, and a position decrement instead of
          liquidate, live, or as a deterministic replay of the venue math.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a href="/dashboard" className="btn-key text-[0.95rem] px-6 py-3.5">
            Enter the venue
            <span aria-hidden="true">↗</span>
          </a>
          <a href="#sdk" className="btn-ghost text-[0.95rem] px-6 py-3.5">
            Read the SDK
          </a>
        </div>
      </div>

      <footer className="relative border-t border-[var(--line)]">
        <div className="mx-auto max-w-[1480px] px-4 sm:px-6 py-7 flex flex-wrap items-center justify-between gap-4 text-[11px] text-[var(--fg-dim)]">
          <span>
            SideKick Perps · an agent-native perpetual futures venue · Arc testnet ·{" "}
            <span className="text-[var(--fg-mid)]">not affiliated with any exchange</span>
          </span>
          <span className="flex items-center gap-4">
            <a href="/dashboard" className="hover:text-[var(--fg)] transition-colors">
              Dashboard
            </a>
            <a href="#sdk" className="hover:text-[var(--fg)] transition-colors">
              SDK
            </a>
            <span className="font-mono">@sidekick/sdk</span>
          </span>
        </div>
      </footer>
    </section>
  );
}

/* ── shared ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * SectionHead: a deliberate, sparse section marker. A single lettered index (A/B/C/D) + a display
 * title + a lede. The letters are a real sequence (the page's four movements), not a per-section
 * eyebrow trope, used once each, in order, as the page's spine.
 */
function SectionHead({
  index,
  title,
  lede,
}: {
  index: string;
  title: string;
  lede: string;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-5 lg:gap-12 items-start">
      <div className="flex items-center gap-3 lg:flex-col lg:items-start lg:gap-2 lg:pt-2">
        <span className="font-display font-bold text-2xl text-[var(--fg-dim)]">{index}</span>
        <span className="hidden lg:block w-px h-16 bg-gradient-to-b from-[var(--line-bright)] to-transparent" />
      </div>
      <div className="max-w-3xl">
        <h2 className="display-lg">{title}</h2>
        <p className="lede mt-4 text-[14px] sm:text-[15px]">{lede}</p>
      </div>
    </div>
  );
}
