"use client";

/**
 * PoolHealth: the pool as the stable headline, settlement flow kept separate (Doc 2 §7.1, panel 4;
 * the Ostium-borrowed clarity in Doc 1 §7 / Doc 3 §10).
 *
 * "Pool capital / LP claim value" is the big, STABLE number. Per-block margin-call + funding flow makes
 * pool USDC swing constantly, so that flow is shown as a SEPARATE, clearly-labelled stream, never
 * folded into the headline, so a judge never mistakes normal settlement movement for losses.
 *
 * Also surfaces the gap fund (the only place bad debt enters, Doc 1 §4.2) and pool equity at mark.
 */

import { num, usd, usdCompact } from "@/lib/format.ts";
import type { PoolState } from "@/lib/types.ts";
import { Panel, Readout, Sparkline } from "./ui.tsx";

export function PoolHealth({
  pool,
  capitalHistory,
  flowThisBlock,
}: {
  pool: PoolState;
  capitalHistory: number[];
  flowThisBlock: number;
}) {
  const capital = num(pool.capital);
  const equity = num(pool.equity);
  const gap = num(pool.gapFund);
  const fundingAccrued = num(pool.fundingAccrued);
  const unrealized = equity - capital;

  return (
    <Panel title="Pool health" hint="universal counterparty">
      <div className="space-y-4">
        {/* The stable headline. */}
        <div className="flex items-end justify-between">
          <Readout
            label="LP claim value (capital)"
            value={usd(capital)}
            size="xl"
            color="var(--accent-pool)"
            sub={
              <span
                style={{ color: unrealized >= 0 ? "var(--accent-long)" : "var(--accent-short)" }}
              >
                equity at mark {usd(equity)} ({unrealized >= 0 ? "+" : "−"}
                {usdCompact(Math.abs(unrealized))} unreal.)
              </span>
            }
          />
          <Sparkline data={capitalHistory} color="var(--accent-pool)" width={120} height={40} />
        </div>

        {/* The SEPARATE flow line, explicitly not the headline. */}
        <div className="rounded border border-[var(--line)] bg-[var(--bg-panel-2)] px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Settlement flow · this block</span>
            <span
              className="tnum font-display font-semibold text-sm"
              style={{ color: flowThisBlock >= 0 ? "var(--accent-long)" : "var(--accent-short)" }}
            >
              {flowThisBlock === 0 ? "-" : usd(flowThisBlock, { sign: true })}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-[var(--fg-dim)] leading-snug">
            Operational movement (funding + margin calls), not PnL. The headline above stays stable
            while this swings every block.
          </p>
        </div>

        {/* Secondary readouts. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded border border-[var(--line)] px-3 py-2">
            <div className="eyebrow mb-1">Gap fund</div>
            <div className="tnum font-semibold text-[var(--warn)]">{usd(gap)}</div>
            <div className="text-[10px] text-[var(--fg-dim)] mt-0.5">single-block gap reserve</div>
          </div>
          <div className="rounded border border-[var(--line)] px-3 py-2">
            <div className="eyebrow mb-1">Funding accrued</div>
            <div
              className="tnum font-semibold"
              style={{ color: fundingAccrued >= 0 ? "var(--accent-long)" : "var(--accent-short)" }}
            >
              {usd(fundingAccrued, { sign: true })}
            </div>
            <div className="text-[10px] text-[var(--fg-dim)] mt-0.5">net to the pool</div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
