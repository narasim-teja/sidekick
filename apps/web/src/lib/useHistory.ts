"use client";

/**
 * `useSeries` — accumulate a numeric value across renders into a bounded ring buffer for sparklines.
 * Keyed so switching markets resets the series cleanly. Pure client state; no I/O.
 */

import { useEffect, useRef, useState } from "react";

export function useSeries(value: number | undefined, cap = 60, key?: string): number[] {
  const [series, setSeries] = useState<number[]>([]);
  const lastKey = useRef(key);

  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      setSeries(value === undefined ? [] : [value]);
      return;
    }
    if (value === undefined || !Number.isFinite(value)) return;
    setSeries((prev) => {
      const last = prev[prev.length - 1];
      if (last === value && prev.length > 0) return prev; // skip no-op repeats
      const next = [...prev, value];
      return next.length > cap ? next.slice(next.length - cap) : next;
    });
  }, [value, cap, key]);

  return series;
}
