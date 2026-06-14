"use client";

/**
 * Dashboard: the live client root. Wires the single {@link useFeed} data source into every panel and
 * lays out the instrument grid:
 *
 *   ┌─ Header (mode badge, chain, checkpoint) ────────────────────────────────┐
 *   ├─ Hero (3D settlement network) ──────────────┬─ Market panel ────────────┤
 *   ├─ Settlement stream ─────────────────────────┼─ Pool health ─────────────┤
 *   ├─ Positions table ───────────────────────────┴─ Agent roster ────────────┤
 *   └─ Footer (provenance + how-to-go-live) ──────────────────────────────────┘
 *
 * The hero is dynamically imported with SSR off (three.js requires the DOM). All live data is
 * client-only (the engine WS/REST feed, or the replay fallback), so the data grid renders behind a
 * `mounted` gate: SSR emits a stable shell and the first client render matches it, then the live
 * content paints, no hydration mismatch from feed floats / locale-formatted numbers. One source of
 * truth: the feed.
 */

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { num } from "@/lib/format.ts";
import { useFeed } from "@/lib/useFeed.ts";
import { useSeries } from "@/lib/useHistory.ts";
import { AgentRoster } from "./AgentRoster.tsx";
import { Header } from "./Header.tsx";
import { MarketPanel } from "./MarketPanel.tsx";
import { PoolHealth } from "./PoolHealth.tsx";
import { PositionsTable } from "./PositionsTable.tsx";
import { SettlementStream } from "./SettlementStream.tsx";

// three.js can only run in the browser, load the hero with SSR disabled.
const HeroSection = dynamic(() => import("./HeroSection.tsx").then((m) => m.HeroSection), {
  ssr: false,
  loading: () => (
    <div className="panel ticked flex items-center justify-center" style={{ minHeight: 420 }}>
      <span className="text-[12px] text-[var(--fg-dim)] tracking-widest animate-pulse">
        initializing settlement network…
      </span>
    </div>
  ),
});

export function Dashboard() {
  // Render the live grid only after mount so the SSR shell and the first client render agree (the feed
  // is client-only). Avoids hydration mismatches from feed-driven floats / locale-formatted numbers.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const feed = useFeed();
  const focus = feed.focus;

  // Sparkline series, keyed on the focused market so they reset on a market switch.
  const markSeries = useSeries(focus ? num(focus.mark) : undefined, 60, feed.focusMarket);
  const capitalSeries = useSeries(
    focus ? num(focus.pool.capital) : undefined,
    60,
    feed.focusMarket,
  );

  // Net pool settlement flow this block = −Σ(account funding+paid), i.e. what flowed to/from the pool.
  const flowThisBlock = useMemo(() => {
    if (!feed.lastEvents.length) return 0;
    // Account-signed amounts; the pool takes the opposite sign of the aggregate.
    return -feed.lastEvents.reduce((acc, e) => acc + num(e.amount), 0);
  }, [feed.lastEvents]);

  if (!mounted) {
    return (
      <main className="relative min-h-screen grid-bg flex items-center justify-center">
        <span className="text-[12px] text-[var(--fg-dim)] tracking-[0.3em] uppercase animate-pulse">
          SideKick · booting instrument panel…
        </span>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen grid-bg">
      <div className="relative mx-auto max-w-[1480px] px-4 sm:px-6 py-5">
        <div className="rise" style={{ animationDelay: "0ms" }}>
          <Header
            mode={feed.mode}
            status={feed.status}
            venue={feed.venue}
            focus={focus}
            markets={feed.markets}
            focusMarket={feed.focusMarket}
            onSelectMarket={feed.selectMarket}
          />
        </div>

        {/* Hero + market cluster */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
          <div className="rise" style={{ animationDelay: "80ms" }}>
            <HeroSection state={focus} lastEvents={feed.lastEvents} feed={feed.feed} />
          </div>
          <div className="rise" style={{ animationDelay: "160ms" }}>
            {focus ? (
              <MarketPanel state={focus} markHistory={markSeries} />
            ) : (
              <EmptyPanel label="market" />
            )}
          </div>
        </div>

        {/* Stream + pool */}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
          <div className="rise" style={{ animationDelay: "240ms" }}>
            <SettlementStream feed={feed.feed} />
          </div>
          <div className="rise" style={{ animationDelay: "320ms" }}>
            {focus ? (
              <PoolHealth
                pool={focus.pool}
                capitalHistory={capitalSeries}
                flowThisBlock={flowThisBlock}
              />
            ) : (
              <EmptyPanel label="pool" />
            )}
          </div>
        </div>

        {/* Positions + agents */}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
          <div className="rise" style={{ animationDelay: "400ms" }}>
            <PositionsTable positions={focus?.positions ?? []} />
          </div>
          <div className="rise" style={{ animationDelay: "480ms" }}>
            <AgentRoster state={focus} />
          </div>
        </div>

        <Footer mode={feed.mode} engineUrl={feed.engineUrl} markets={Object.keys(feed.states)} />
      </div>
    </main>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="panel ticked flex items-center justify-center" style={{ minHeight: 200 }}>
      <span className="text-[12px] text-[var(--fg-dim)]">awaiting {label} state…</span>
    </div>
  );
}

function Footer({
  mode,
  engineUrl,
  markets,
}: {
  mode: string;
  engineUrl: string;
  markets: string[];
}) {
  return (
    <footer className="mt-8 pt-4 border-t border-[var(--line)] flex flex-wrap items-center justify-between gap-3 text-[10px] text-[var(--fg-dim)]">
      <div className="flex items-center gap-3">
        <span>
          SideKick Perps · observability dashboard · {markets.length ? markets.join(" · ") : "-"}
        </span>
      </div>
      <div>
        {mode === "replay" ? (
          <span>
            Engine offline, showing a deterministic replay of the venue math. Go live:{" "}
            <code className="text-[var(--fg-mid)]">bun run engine</code> →{" "}
            <code className="text-[var(--fg-mid)]">bun run demo</code> (set{" "}
            <code className="text-[var(--fg-mid)]">NEXT_PUBLIC_ENGINE_URL</code> for a remote
            engine).
          </span>
        ) : (
          <span>
            live against <code className="text-[var(--fg-mid)]">{engineUrl}</code>
          </span>
        )}
      </div>
    </footer>
  );
}
