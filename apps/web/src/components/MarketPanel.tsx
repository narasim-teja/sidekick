"use client";

/**
 * MarketPanel — the per-market instrument cluster (Doc 2 §7.1, panel 1):
 *   • live mark + provenance badge (so a synthetic fallback is labelled honestly)
 *   • the convex funding curve `clamp(α·S·|S|, ±r_max)` drawn, with the live skew marked on it
 *   • skew vs the Layer-2 OI cap as a gauge
 *   • open interest long / short
 *
 * The funding curve is the visual that proves "flat near balance, steep near the extremes" — the
 * single most defensible piece of the funding design (Doc 1 §4.1).
 */

import { useMemo } from "react";
import { mark as fmtMark, num, rateBps, skewPct, usdCompact } from "@/lib/format.ts";
import type { MarketBlockState } from "@/lib/types.ts";
import { Bar, Chip, Panel, Readout, Sparkline } from "./ui.tsx";

const PARAMS = { alpha: 0.0005, rMax: 0.0005 }; // Phase-1 swept (Doc 1 §4.1); α = r_max.

function provenanceChip(p: MarketBlockState["markProvenance"]) {
  if (p === "stork-live") return <Chip color="var(--signal)">Stork · live</Chip>;
  if (p === "chainlink-live") return <Chip color="var(--accent-mm)">Chainlink · CRE</Chip>;
  return <Chip color="var(--warn)">synthetic mark</Chip>;
}

/** The convex funding curve as an SVG, with the live skew dot. */
function FundingCurve({ skew, rate }: { skew: number; rate: number }) {
  const w = 240;
  const h = 96;
  const pad = 6;
  // rate(S) = clamp(α·S·|S|, ±r_max). Plot S∈[−1,1] → x, rate∈[−r_max,r_max] → y.
  const path = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 80; i++) {
      const S = -1 + (i / 80) * 2;
      const raw = PARAMS.alpha * S * Math.abs(S);
      const r = Math.max(-PARAMS.rMax, Math.min(PARAMS.rMax, raw));
      const x = pad + ((S + 1) / 2) * (w - 2 * pad);
      const y = h / 2 - (r / PARAMS.rMax) * (h / 2 - pad);
      pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(" ");
  }, []);

  const sx = pad + ((Math.max(-1, Math.min(1, skew)) + 1) / 2) * (w - 2 * pad);
  const clamped = Math.max(-PARAMS.rMax, Math.min(PARAMS.rMax, rate));
  const sy = h / 2 - (clamped / PARAMS.rMax) * (h / 2 - pad);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" role="img" aria-label="Funding curve">
      {/* axes */}
      <line
        x1={pad}
        y1={h / 2}
        x2={w - pad}
        y2={h / 2}
        stroke="var(--line-bright)"
        strokeWidth="1"
        strokeDasharray="2 3"
      />
      <line x1={w / 2} y1={pad} x2={w / 2} y2={h - pad} stroke="var(--line)" strokeWidth="1" />
      {/* the convex curve */}
      <path
        d={path}
        fill="none"
        stroke="var(--accent-funding)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* live skew marker */}
      <line
        x1={sx}
        y1={pad}
        x2={sx}
        y2={h - pad}
        stroke="var(--signal)"
        strokeWidth="1"
        strokeOpacity="0.4"
      />
      <circle cx={sx} cy={sy} r="4" fill="var(--signal)">
        <animate attributeName="r" values="4;6;4" dur="1.8s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

export function MarketPanel({
  state,
  markHistory,
}: {
  state: MarketBlockState;
  markHistory: number[];
}) {
  const oiLong = num(state.oiLong);
  const oiShort = num(state.oiShort);
  const oiTotal = oiLong + oiShort || 1;
  const exposure = num(state.pool.exposure);
  const cap = num(state.pool.cap) || 1;
  const capRatio = exposure / cap;

  return (
    <Panel
      title={state.market}
      right={
        <div className="flex items-center gap-2">
          {provenanceChip(state.markProvenance)}
          <span className="text-[10px] text-[var(--fg-dim)] tnum">
            blk {state.arcBlock.toLocaleString()}
          </span>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        {/* Mark */}
        <div className="col-span-2 flex items-end justify-between">
          <Readout label="Mark" value={fmtMark(state.mark)} size="xl" color="var(--fg)" />
          <Sparkline data={markHistory} color="var(--signal)" width={140} height={40} />
        </div>

        {/* Funding curve */}
        <div className="col-span-2">
          <div className="flex items-center justify-between mb-1">
            <span className="eyebrow">Convex funding · rate(S)</span>
            <span
              className="tnum text-sm font-display font-semibold"
              style={{ color: "var(--accent-funding)" }}
            >
              {rateBps(state.fundingRate)}
            </span>
          </div>
          <FundingCurve skew={state.smoothSkew} rate={state.fundingRate} />
          <div className="flex justify-between text-[10px] text-[var(--fg-dim)] mt-0.5">
            <span>all short</span>
            <span>balanced</span>
            <span>all long</span>
          </div>
        </div>

        {/* Skew vs cap */}
        <div className="col-span-2">
          <div className="flex items-center justify-between mb-1">
            <span className="eyebrow">Pool exposure vs Layer-2 cap (k·capital)</span>
            <span
              className="tnum text-[11px]"
              style={{ color: capRatio > 0.85 ? "var(--warn)" : "var(--fg-mid)" }}
            >
              {usdCompact(exposure)} / {usdCompact(cap)}
            </span>
          </div>
          <Bar
            ratio={capRatio}
            color={capRatio > 0.85 ? "var(--warn)" : "var(--accent-pool)"}
            height={10}
          />
          <div className="mt-0.5 text-[10px] text-[var(--fg-dim)]">
            skew {skewPct(state.skew)} · smoothed {skewPct(state.smoothSkew)}
          </div>
        </div>

        {/* OI split */}
        <div className="col-span-2">
          <div className="eyebrow mb-1.5">Open interest</div>
          <div className="flex h-7 rounded overflow-hidden border border-[var(--line)]">
            <div
              className="flex items-center justify-start px-2 text-[11px] font-semibold tnum transition-[flex-basis] duration-500"
              style={{
                flexBasis: `${(oiLong / oiTotal) * 100}%`,
                background: "rgba(56,249,176,0.16)",
                color: "var(--accent-long)",
              }}
            >
              {usdCompact(oiLong)}
            </div>
            <div
              className="flex items-center justify-end px-2 text-[11px] font-semibold tnum transition-[flex-basis] duration-500"
              style={{
                flexBasis: `${(oiShort / oiTotal) * 100}%`,
                background: "rgba(255,92,122,0.16)",
                color: "var(--accent-short)",
              }}
            >
              {usdCompact(oiShort)}
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-[var(--fg-dim)] mt-1">
            <span>long</span>
            <span>short</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
