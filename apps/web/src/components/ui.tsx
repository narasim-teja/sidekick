"use client";

/**
 * Small presentational primitives shared across panels: the panel shell with an instrument-style
 * header, a value readout that flashes on change, sparklines, and bars/gauges. Kept dependency-free
 * (inline SVG, CSS animations) so the dashboard bundle stays light.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";

/** A bordered instrument panel with an eyebrow header and optional right-aligned status. */
export function Panel({
  title,
  hint,
  right,
  children,
  className = "",
  style,
}: {
  title?: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`panel ticked ${className}`} style={style}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3 pb-2 border-b border-[var(--line)]">
          <div className="flex items-baseline gap-2 min-w-0">
            {title && <h2 className="eyebrow truncate">{title}</h2>}
            {hint && <span className="text-[10px] text-[var(--fg-dim)] truncate">{hint}</span>}
          </div>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A big readout that flashes when its value changes (the "this just updated" cue). */
export function Readout({
  value,
  label,
  sub,
  color = "var(--fg)",
  size = "lg",
}: {
  value: string;
  label?: string;
  sub?: ReactNode;
  color?: string;
  size?: "sm" | "lg" | "xl";
}) {
  const flash = useFlashOnChange(value);
  const sizeCls = size === "xl" ? "text-3xl" : size === "lg" ? "text-2xl" : "text-lg";
  return (
    <div>
      {label && <div className="eyebrow mb-1">{label}</div>}
      <div
        className={`font-display font-semibold tnum leading-none ${sizeCls} ${flash ? "flash" : ""} rounded px-0.5`}
        style={{ color }}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-[var(--fg-dim)] tnum">{sub}</div>}
    </div>
  );
}

/** Detect a value change and return true for one render (drives the .flash class). */
export function useFlashOnChange(value: string | number): boolean {
  const prev = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setOn(true);
      const t = setTimeout(() => setOn(false), 700);
      return () => clearTimeout(t);
    }
  }, [value]);
  return on;
}

/** A horizontal progress/usage bar (e.g. exposure vs cap). */
export function Bar({
  ratio,
  color = "var(--signal)",
  track = "var(--bg-raised)",
  height = 8,
}: {
  ratio: number;
  color?: string;
  track?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div
      className="w-full rounded-full overflow-hidden"
      style={{ background: track, height }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%`, background: color, boxShadow: `0 0 10px ${color}` }}
      />
    </div>
  );
}

/** A minimal sparkline from a series of numbers. */
export function Sparkline({
  data,
  color = "var(--signal)",
  width = 120,
  height = 32,
  fill = true,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
}) {
  if (data.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  // Round every coordinate deterministically — raw floats in SVG attributes differ by a ULP between
  // the SSR pass and client render and trip React hydration ("y1 differs"), so we never emit them raw.
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const pts = data.map((d, i) => {
    const x = r1(i * stepX);
    const y = r1(height - ((d - min) / range) * (height - 2) - 1);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = `spk-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg width={width} height={height} aria-hidden="true" className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={pts[pts.length - 1]?.[0]} cy={pts[pts.length - 1]?.[1]} r={2} fill={color} />
    </svg>
  );
}

/** A small chip / tag. */
export function Chip({
  children,
  color = "var(--fg-dim)",
  filled = false,
}: {
  children: ReactNode;
  color?: string;
  filled?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] tracking-wider uppercase"
      style={{
        color: filled ? "var(--bg)" : color,
        background: filled ? color : "transparent",
        border: `1px solid ${color}`,
      }}
    >
      {children}
    </span>
  );
}
