"use client";

/**
 * HeroSection — the centerpiece. Hosts the three.js {@link PacketHero} settlement network and overlays
 * the live headline: the funding-strategy "hero" status and the dark-agent decrement status (Doc 2 §7.2:
 * "the hero screen is the funding-strategy agent holding pure funding exposure + the dark agent
 * decrementing smoothly"), plus a running nanopayment counter.
 *
 * It is dynamically imported with SSR off (three.js needs the DOM), and pauses its render loop when the
 * tab is hidden to spare the GPU.
 */

import { useEffect, useMemo, useState } from "react";
import { num, usd } from "@/lib/format.ts";
import type { MarketBlockState, SettlementEvent } from "@/lib/types.ts";
import { profileFor } from "@/lib/venue.ts";
import { NetworkFallback2D } from "./NetworkFallback2D.tsx";
import { type HeroNode, PacketHero } from "./PacketHero.tsx";
import { useFlashOnChange } from "./ui.tsx";

export function HeroSection({
  state,
  lastEvents,
  feed,
}: {
  state: MarketBlockState | undefined;
  lastEvents: SettlementEvent[];
  feed: SettlementEvent[];
}) {
  const [hidden, setHidden] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Ring nodes = the live positions, sized by notional share.
  const nodes: HeroNode[] = useMemo(() => {
    if (!state) return [];
    const maxN = Math.max(...state.positions.map((p) => num(p.notionalAfter)), 1);
    return state.positions
      .filter((p) => num(p.notionalAfter) > 0)
      .map((p) => ({
        account: p.account,
        weight: num(p.notionalAfter) / maxN,
        role: profileFor(p.account).role,
      }));
  }, [state]);

  // Headline agent statuses.
  const hero = state?.positions.find((p) => profileFor(p.account).role === "funding");
  const dark = state?.positions.find((p) => profileFor(p.account).role === "dark");

  // Total nanopayment count (the headline x402 kind) across the session.
  const nanoCount = useMemo(() => feed.filter((e) => e.kind === "margin-call").length, [feed]);
  const totalCount = feed.length;

  return (
    <div className="relative panel ticked scanlines overflow-hidden" style={{ minHeight: 420 }}>
      {/* three.js canvas — or a 2D SVG fallback if WebGL is unavailable (headless / locked-down GPU). */}
      {webglFailed ? (
        <NetworkFallback2D events={lastEvents} nodes={nodes} />
      ) : (
        <PacketHero
          events={lastEvents}
          nodes={nodes}
          paused={hidden}
          onUnsupported={() => setWebglFailed(true)}
        />
      )}

      {/* gradient scrim so text reads over the 3D */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, rgba(7,9,12,0.92) 0%, rgba(7,9,12,0.45) 38%, transparent 60%)",
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-24 pointer-events-none"
        style={{ background: "linear-gradient(0deg, rgba(7,9,12,0.9), transparent)" }}
      />

      {/* Overlay content */}
      <div
        className="relative z-10 p-6 flex flex-col justify-between h-full"
        style={{ minHeight: 420 }}
      >
        <div className="max-w-md">
          <div className="eyebrow mb-2" style={{ color: "var(--signal)" }}>
            ◢ live settlement network
          </div>
          <h2 className="font-display font-bold text-2xl leading-tight">
            Thousands of sub-cent payments,
            <br />
            <span style={{ color: "var(--accent-nano)" }}>every block</span> — made visible.
          </h2>
          <p className="mt-2 text-[12px] text-[var(--fg-mid)] leading-relaxed">
            Each packet is a real settlement event flying between an agent and the pool. Magenta is
            the x402 Gateway <span style={{ color: "var(--accent-nano)" }}>nanopayment</span>; amber
            is the funding stream; cyan is an in-checkpoint auto-settle.
          </p>
        </div>

        {/* Bottom overlay: hero + dark statuses + counters */}
        <div className="flex flex-wrap items-end justify-between gap-4 mt-6">
          <div className="flex gap-3">
            {hero && (
              <HeroCard
                label="FUNDING HERO"
                color="var(--accent-funding)"
                line={`pure funding exposure · ${usd(num(hero.funding), { sign: true })}/blk`}
                note="price risk shed, funding kept"
              />
            )}
            {dark && (
              <HeroCard
                label="DARK AGENT"
                color="var(--accent-dark)"
                line={`N ${usd(num(dark.notionalBefore))} → ${usd(num(dark.notionalAfter))}`}
                note={
                  dark.outcome === "decrement"
                    ? "decrementing — no liquidation"
                    : "silent · holding"
                }
              />
            )}
          </div>
          <div className="flex gap-5 text-right">
            <Counter value={totalCount} label="settlements" color="var(--signal)" />
            <Counter value={nanoCount} label="nanopayments" color="var(--accent-nano)" />
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroCard({
  label,
  color,
  line,
  note,
}: {
  label: string;
  color: string;
  line: string;
  note: string;
}) {
  return (
    <div className="panel-raised rounded px-3 py-2 backdrop-blur-sm" style={{ borderColor: color }}>
      <div className="text-[9px] font-semibold tracking-widest" style={{ color }}>
        {label}
      </div>
      <div className="text-[12px] tnum font-semibold mt-0.5">{line}</div>
      <div className="text-[10px] text-[var(--fg-dim)]">{note}</div>
    </div>
  );
}

/**
 * A counter readout. The value IS the truth (a count), so it renders directly — no rAF easing (which is
 * throttled in background/headless contexts and is just sugar). A brief flash on each increment via the
 * `flash` class gives the "ticking up" feel without a fragile animation loop.
 */
function Counter({ value, label, color }: { value: number; label: string; color: string }) {
  const flash = useFlashOnChange(value);
  return (
    <div>
      <div
        className={`font-display font-bold text-2xl tnum leading-none rounded px-0.5 transition-colors ${flash ? "flash" : ""}`}
        style={{ color }}
      >
        {Math.max(0, value).toLocaleString()}
      </div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}
