"use client";

/**
 * Header — the masthead + live status bar. Carries the venue identity, the LIVE / REPLAY mode badge
 * (so the data provenance is always honest), the chain, the engine operator, the funding cadence, and
 * the latest on-chain checkpoint tx (linked to Arcscan). The per-block "heartbeat" dot pulses on each
 * new tick so the page visibly breathes with the loop.
 */

import type { EngineStatus, FeedMode, MarketBlockState, VenueDescriptor } from "@/lib/types.ts";
import { arcscanTx, shortAddress } from "@/lib/venue.ts";

function ModeBadge({ mode }: { mode: FeedMode }) {
  if (mode === "live") {
    return (
      <span
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded border"
        style={{ borderColor: "var(--signal)", color: "var(--signal)" }}
      >
        <span className="pulse w-1.5 h-1.5 rounded-full" style={{ background: "var(--signal)" }} />
        <span className="text-[11px] font-semibold tracking-widest">LIVE</span>
      </span>
    );
  }
  if (mode === "replay") {
    return (
      <span
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded border"
        style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
        title="Engine offline — showing a deterministic demo replay of the venue math."
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--warn)" }} />
        <span className="text-[11px] font-semibold tracking-widest">REPLAY</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded border border-[var(--line-bright)] text-[var(--fg-dim)]">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--fg-dim)] animate-pulse" />
      <span className="text-[11px] font-semibold tracking-widest">CONNECTING</span>
    </span>
  );
}

export function Header({
  mode,
  status,
  venue,
  focus,
  markets,
  focusMarket,
  onSelectMarket,
}: {
  mode: FeedMode;
  status: EngineStatus | undefined;
  venue: VenueDescriptor | undefined;
  focus: MarketBlockState | undefined;
  markets: string[];
  focusMarket: string | undefined;
  onSelectMarket: (m: string) => void;
}) {
  const chainId = venue?.chainId ?? status?.chainId ?? 5042002;
  const operator = venue?.operator ?? status?.operator;
  const blockSeconds = venue?.cadence.blockSeconds ?? 2;
  const checkpointEvery =
    venue?.cadence.checkpointEveryBlocks ?? status?.checkpointEveryBlocks ?? 1;

  return (
    <header className="relative">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {/* Wordmark */}
          <div className="flex items-center gap-2.5">
            <Logo />
            <div>
              <h1 className="font-display font-bold text-xl leading-none tracking-tight">
                SIDE<span style={{ color: "var(--signal)" }}>KICK</span>
              </h1>
              <p className="text-[10px] text-[var(--fg-dim)] tracking-[0.2em] uppercase mt-0.5">
                agent-native perp venue
              </p>
            </div>
          </div>
          <ModeBadge mode={mode} />
        </div>

        {/* Status readouts */}
        <div className="flex items-center gap-5 text-[11px] tnum">
          <Stat label="Chain" value={`Arc · ${chainId}`} />
          <Stat label="Block" value={`~${blockSeconds}s`} />
          <Stat label="Checkpoint" value={`every ${checkpointEvery}`} />
          {operator && <Stat label="Operator" value={shortAddress(operator)} />}
          {focus?.checkpoint && (
            <a
              href={arcscanTx(focus.checkpoint.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="group"
              title="latest on-chain checkpoint"
            >
              <div className="eyebrow">Last checkpoint</div>
              <div className="text-[var(--accent-mm)] group-hover:underline">
                #{focus.checkpoint.index} · {shortAddress(focus.checkpoint.txHash)} ↗
              </div>
            </a>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-[var(--fg-mid)] max-w-2xl leading-relaxed">
          The per-block loop, made visible. Continuous funding, no liquidations, and gas-free
          nanopayment settlement on Arc — re-marked and reconciled every {blockSeconds} seconds. Not
          a trading chart.
        </p>
        {/* Market selector — only when the engine runs more than one market. */}
        {markets.length > 1 && (
          <div className="flex items-center gap-1 panel-raised rounded p-1">
            {markets.map((m) => {
              const active = m === focusMarket;
              return (
                <button
                  type="button"
                  key={m}
                  onClick={() => onSelectMarket(m)}
                  className="px-2.5 py-1 rounded text-[11px] font-semibold tracking-wide transition-colors"
                  style={{
                    background: active ? "var(--signal)" : "transparent",
                    color: active ? "var(--bg)" : "var(--fg-mid)",
                  }}
                >
                  {m}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="text-[var(--fg)]">{value}</div>
    </div>
  );
}

/** A small geometric mark — concentric ticks around a core, echoing the pool/agent ring. */
function Logo() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r="15" fill="none" stroke="var(--line-bright)" strokeWidth="1" />
      <circle cx="17" cy="17" r="4.5" fill="var(--signal)" />
      {Array.from({ length: 12 }, (_, i) => i).map((i) => {
        const a = (i / 12) * Math.PI * 2;
        const x1 = 17 + Math.cos(a) * 9;
        const y1 = 17 + Math.sin(a) * 9;
        const x2 = 17 + Math.cos(a) * 12.5;
        const y2 = 17 + Math.sin(a) * 12.5;
        return (
          <line
            key={`tick-${i}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="var(--signal-dim)"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}
