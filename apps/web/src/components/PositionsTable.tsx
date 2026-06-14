"use client";

/**
 * PositionsTable: every live position, its margin health, and the live decrement (Doc 2 §7.1, panel 3).
 *
 * The load-bearing column is `outcome` + the notional-before→after delta: when the dark agent goes
 * silent you watch its notional step DOWN block by block (`N' = E/m`) instead of a liquidation cliff , 
 * the anti-liquidation proof, on camera (Doc 3 §11 step 3). A small inline bar shows how far each
 * position has decremented from its peak.
 */

import { useEffect, useRef } from "react";
import { num, usd } from "@/lib/format.ts";
import type { PositionState } from "@/lib/types.ts";
import { profileFor, shortAddress } from "@/lib/venue.ts";
import { Chip, Panel } from "./ui.tsx";

const OUTCOME_META: Record<PositionState["outcome"], { label: string; color: string }> = {
  healthy: { label: "HEALTHY", color: "var(--signal)" },
  "topped-up": { label: "TOPPED UP", color: "var(--accent-pool)" },
  decrement: { label: "DECREMENT", color: "var(--warn)" },
  gap: { label: "GAP", color: "var(--danger)" },
};

export function PositionsTable({ positions }: { positions: PositionState[] }) {
  // Track each account's peak notional so the decrement bar reads against its own high-water mark.
  const peaks = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const p of positions) {
      const key = p.account.toLowerCase();
      const before = num(p.notionalBefore);
      peaks.current.set(key, Math.max(peaks.current.get(key) ?? 0, before));
    }
  }, [positions]);

  const sorted = [...positions].sort((a, b) => num(b.notionalAfter) - num(a.notionalAfter));

  return (
    <Panel
      title="Positions"
      hint="unified accounts: trader · MM · funding · dark"
      className="h-full"
    >
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="eyebrow text-left">
              <th className="font-normal pb-2 pl-1">Agent</th>
              <th className="font-normal pb-2">Side</th>
              <th className="font-normal pb-2 text-right">Notional</th>
              <th className="font-normal pb-2 text-right">Equity</th>
              <th className="font-normal pb-2 text-right">Funding</th>
              <th className="font-normal pb-2 text-right pr-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-[var(--fg-dim)] py-8 text-[12px]">
                  no open positions yet
                </td>
              </tr>
            )}
            {sorted.map((p) => {
              const profile = profileFor(p.account);
              const after = num(p.notionalAfter);
              const before = num(p.notionalBefore);
              const peak = (peaks.current.get(p.account.toLowerCase()) ?? before) || 1;
              const remaining = peak > 0 ? after / peak : 0;
              const meta = OUTCOME_META[p.outcome];
              const decrementing = p.outcome === "decrement" || p.outcome === "gap";
              const equity = num(p.equity);
              const funding = num(p.funding);
              return (
                <tr key={p.account} className="border-t border-[var(--line)] align-middle">
                  <td className="py-2 pl-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: profile.accent }}
                      />
                      <span className="font-semibold" style={{ color: profile.accent }}>
                        {profile.role !== "unknown" ? profile.label : shortAddress(p.account)}
                      </span>
                    </div>
                  </td>
                  <td className="py-2">
                    <span
                      style={{
                        color: p.side === "long" ? "var(--accent-long)" : "var(--accent-short)",
                      }}
                    >
                      {p.side}
                    </span>
                  </td>
                  <td className="py-2 text-right tnum">
                    <div className="font-semibold">{usd(after)}</div>
                    {/* decrement bar against the account's own peak */}
                    <div
                      className="mt-0.5 ml-auto w-16 h-1 rounded-full overflow-hidden"
                      style={{ background: "var(--bg-raised)" }}
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{
                          width: `${Math.max(0, Math.min(1, remaining)) * 100}%`,
                          background: decrementing ? "var(--warn)" : profile.accent,
                        }}
                      />
                    </div>
                  </td>
                  <td
                    className="py-2 text-right tnum"
                    style={{ color: equity < 0 ? "var(--danger)" : "var(--fg-mid)" }}
                  >
                    {usd(equity)}
                  </td>
                  <td
                    className="py-2 text-right tnum"
                    style={{ color: funding >= 0 ? "var(--accent-long)" : "var(--accent-short)" }}
                  >
                    {funding === 0 ? "-" : usd(funding, { sign: true })}
                  </td>
                  <td className="py-2 text-right pr-1">
                    <Chip color={meta.color} filled={p.outcome === "decrement"}>
                      {meta.label}
                    </Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 pt-2 border-t border-[var(--line)] text-[10px] text-[var(--fg-dim)] leading-relaxed">
        No liquidations. An unanswered margin call shrinks the position to maintenance-adequacy (
        <span className="tnum">N′ = E / m</span>), a smooth trim, never a penalty cliff.
      </p>
    </Panel>
  );
}
