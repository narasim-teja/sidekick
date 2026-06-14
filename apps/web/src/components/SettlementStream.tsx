"use client";

/**
 * SettlementStream — the live nanopayment console (Doc 2 §7.1, panel 2).
 *
 * Each settlement event scrolls in as a console row. The three `kind`s are labelled distinctly so the
 * **Gateway nanopayment** (`margin-call`, the headline sub-cent off-chain x402 payment) reads apart
 * from internal contract moves (`funding`, `auto-settle`) — this is the §5-Layer-B honesty the doc
 * insists on. A running tally per kind sits at the top.
 *
 * The visual point: hundreds of sub-cent rows ticking by, agent ↔ pool, every block — the "thousands
 * of sub-cent payments" claim, made literal.
 */

import { useMemo } from "react";
import { usd } from "@/lib/format.ts";
import type { AuthorizationKind, SettlementEvent } from "@/lib/types.ts";
import { profileFor, shortAddress } from "@/lib/venue.ts";
import { Chip, Panel } from "./ui.tsx";

const KIND_META: Record<AuthorizationKind, { label: string; color: string; note: string }> = {
  funding: { label: "FUNDING", color: "var(--accent-funding)", note: "per-block stream" },
  "auto-settle": { label: "AUTO-SETTLE", color: "var(--accent-pool)", note: "Vault collateral" },
  "margin-call": { label: "NANOPAYMENT", color: "var(--accent-nano)", note: "x402 · Gateway" },
};

export function SettlementStream({ feed }: { feed: SettlementEvent[] }) {
  // Newest first for the console.
  const rows = useMemo(() => [...feed].slice(-90).reverse(), [feed]);

  const tally = useMemo(() => {
    const t: Record<AuthorizationKind, number> = { funding: 0, "auto-settle": 0, "margin-call": 0 };
    for (const e of feed) t[e.kind] = (t[e.kind] ?? 0) + 1;
    return t;
  }, [feed]);

  return (
    <Panel
      title="Settlement stream"
      hint="agent ↔ pool · every block"
      right={
        <div className="flex items-center gap-1.5">
          {(Object.keys(KIND_META) as AuthorizationKind[]).map((k) => (
            <Chip key={k} color={KIND_META[k].color}>
              {KIND_META[k].label} {tally[k]}
            </Chip>
          ))}
        </div>
      }
      className="h-full flex flex-col"
    >
      <div
        className="flex-1 min-h-0 overflow-y-auto scroll-thin -mx-1 px-1"
        style={{ maxHeight: 360 }}
      >
        {rows.length === 0 ? (
          <div className="text-[12px] text-[var(--fg-dim)] py-8 text-center">
            awaiting the first block…
          </div>
        ) : (
          <ul className="space-y-px">
            {rows.map((e, i) => {
              const meta = KIND_META[e.kind];
              const amt = Number(e.amount);
              const pays = amt < 0;
              const profile = profileFor(e.account);
              return (
                <li
                  key={`${e.block}-${e.account}-${e.kind}-${e.amount}-${e.at}`}
                  className={`grid grid-cols-[auto_1fr_auto] items-center gap-2 px-2 py-1 rounded text-[11px] ${i === 0 ? "streamin" : ""}`}
                  style={{ background: i % 2 ? "transparent" : "rgba(255,255,255,0.012)" }}
                >
                  <span className="tnum text-[var(--fg-dim)] w-10">#{e.block}</span>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: meta.color, boxShadow: `0 0 6px ${meta.color}` }}
                    />
                    <span className="font-semibold tracking-wide" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                    <span className="text-[var(--fg-dim)] truncate">
                      {profile.role !== "unknown"
                        ? profile.label.toLowerCase()
                        : shortAddress(e.account)}
                      <span className="text-[var(--fg-dim)]"> {pays ? "→ pool" : "← pool"}</span>
                    </span>
                  </span>
                  <span
                    className="tnum font-semibold"
                    style={{ color: pays ? "var(--accent-short)" : "var(--accent-long)" }}
                  >
                    {usd(e.amount, { sign: true })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="mt-2 pt-2 border-t border-[var(--line)] text-[10px] text-[var(--fg-dim)] leading-relaxed">
        <span style={{ color: "var(--accent-nano)" }}>NANOPAYMENT</span> = a real x402 Gateway
        off-chain authorization (the sub-cent payment that makes per-block funding viable). FUNDING
        / AUTO-SETTLE are internal contract moves — shown distinct so settlement swings are never
        read as PnL.
      </p>
    </Panel>
  );
}
