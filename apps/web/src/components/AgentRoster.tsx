"use client";

/**
 * AgentRoster: the agent view (Doc 2 §7.1, panel 5): each demo agent's identity, strategy, and live
 * activity. This is where the thesis-proving archetypes are named, the funding-strategy "hero" and
 * the "dark" agent especially. Identity maps from address → role via `NEXT_PUBLIC_AGENTS`
 * (ERC-8004 identity is the on-chain analog; here we surface the role + a live status line).
 */

import { useMemo } from "react";
import { num, usd } from "@/lib/format.ts";
import type { MarketBlockState } from "@/lib/types.ts";
import { arcscanAddress, profileFor, shortAddress } from "@/lib/venue.ts";
import { Panel } from "./ui.tsx";

export function AgentRoster({ state }: { state: MarketBlockState | undefined }) {
  const agents = useMemo(() => {
    if (!state) return [];
    return state.positions
      .map((p) => ({ ...p, profile: profileFor(p.account) }))
      .sort((a, b) => num(b.notionalAfter) - num(a.notionalAfter));
  }, [state]);

  return (
    <Panel title="Agents" hint="autonomous · no human in the loop" className="h-full">
      <ul className="space-y-2">
        {agents.length === 0 && (
          <li className="text-[12px] text-[var(--fg-dim)] py-6 text-center">
            no agents trading yet
          </li>
        )}
        {agents.map((a) => {
          const funding = num(a.funding);
          const after = num(a.notionalAfter);
          const isHero = a.profile.role === "funding";
          const isDark = a.profile.role === "dark";
          return (
            <li
              key={a.account}
              className="rounded border px-3 py-2.5 transition-colors"
              style={{
                borderColor: isHero
                  ? "color-mix(in srgb, var(--accent-funding) 55%, var(--line))"
                  : "var(--line)",
                background: isHero ? "var(--tint-funding)" : "transparent",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="font-display font-semibold text-[12px] tracking-wide"
                    style={{ color: a.profile.accent }}
                  >
                    {a.profile.role !== "unknown" ? a.profile.label : shortAddress(a.account)}
                  </span>
                  {isHero && (
                    <span
                      className="text-[9px] px-1 rounded"
                      style={{ background: a.profile.accent, color: "var(--bg)" }}
                    >
                      HERO
                    </span>
                  )}
                </div>
                <a
                  href={arcscanAddress(a.account)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-[var(--fg-dim)] tnum hover:text-[var(--fg-mid)] transition-colors"
                  title="view on Arcscan"
                >
                  {shortAddress(a.account)} ↗
                </a>
              </div>
              <p className="mt-1 text-[10px] text-[var(--fg-dim)] leading-snug">
                {a.profile.strategy}
              </p>
              <div className="mt-1.5 flex items-center gap-3 text-[10px] tnum">
                <span className="text-[var(--fg-mid)]">
                  {a.side} · {usd(after)}
                </span>
                {funding !== 0 && (
                  <span
                    style={{ color: funding >= 0 ? "var(--accent-long)" : "var(--accent-short)" }}
                  >
                    funding {usd(funding, { sign: true })}
                  </span>
                )}
                {isDark && a.outcome === "decrement" && (
                  <span style={{ color: "var(--warn)" }}>decrementing ↓</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
