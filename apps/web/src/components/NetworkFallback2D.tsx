"use client";

/**
 * NetworkFallback2D — the settlement network as an SVG, used when WebGL can't initialize (headless
 * capture, locked-down GPU, very old browsers). It keeps the same concept as the three.js hero — a
 * central pool ringed by agent nodes, with packets animating along the spokes on each settlement
 * event — so the hero panel is always legible and on-aesthetic, never blank. Pure SVG + SMIL/CSS
 * animation, zero deps.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthorizationKind, SettlementEvent } from "@/lib/types.ts";
import type { HeroNode } from "./PacketHero.tsx";

const KIND_COLOR: Record<AuthorizationKind, string> = {
  funding: "#ffb454",
  "auto-settle": "#57c7ff",
  "margin-call": "#ff52d9",
};
const ROLE_COLOR: Record<string, string> = {
  long: "#38f9b0",
  short: "#ff5c7a",
  mm: "#57c7ff",
  funding: "#ffb454",
  dark: "#b388ff",
  unknown: "#9fb0c0",
};

const W = 760;
const H = 420;
const CX = W * 0.62;
const CY = H * 0.52;
const R = 150;

interface FlyingPacket {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  big: boolean;
}

export function NetworkFallback2D({
  events,
  nodes,
}: {
  events: SettlementEvent[];
  nodes: HeroNode[];
}) {
  const [packets, setPackets] = useState<FlyingPacket[]>([]);
  const idRef = useRef(0);

  // Lay out the agent nodes on a ring; map account → position so packets fly along the right spoke.
  const layout = useMemo(() => {
    const n = Math.max(nodes.length, 1);
    const map = new Map<string, { x: number; y: number; color: string; r: number }>();
    nodes.forEach((node, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      map.set(node.account.toLowerCase(), {
        x: CX + Math.cos(a) * R,
        y: CY + Math.sin(a) * R,
        color: ROLE_COLOR[node.role] ?? ROLE_COLOR.unknown ?? "#9fb0c0",
        r: 8 + node.weight * 10,
      });
    });
    return map;
  }, [nodes]);

  // Spawn packets for each settlement event.
  useEffect(() => {
    if (!events.length) return;
    const spawned: FlyingPacket[] = [];
    for (const e of events) {
      const node = layout.get(e.account.toLowerCase());
      if (!node) continue;
      const pays = Number(e.amount) < 0;
      idRef.current += 1;
      spawned.push({
        id: idRef.current,
        x1: pays ? node.x : CX,
        y1: pays ? node.y : CY,
        x2: pays ? CX : node.x,
        y2: pays ? CY : node.y,
        color: KIND_COLOR[e.kind] ?? "#fff",
        big: e.kind === "margin-call",
      });
    }
    if (!spawned.length) return;
    setPackets((prev) => [...prev, ...spawned].slice(-40));
    // Cull finished packets after the animation duration.
    const t = setTimeout(() => {
      setPackets((prev) => prev.filter((p) => !spawned.some((s) => s.id === p.id)));
    }, 1300);
    return () => clearTimeout(t);
  }, [events, layout]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="absolute inset-0 w-full h-full"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {/* halo ring */}
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke="#2b3645"
        strokeWidth="1"
        strokeDasharray="2 5"
        opacity="0.6"
      />
      {/* spokes */}
      {[...layout.entries()].map(([addr, p]) => (
        <line
          key={`spoke-${addr}`}
          x1={p.x}
          y1={p.y}
          x2={CX}
          y2={CY}
          stroke={p.color}
          strokeWidth="1"
          opacity="0.12"
        />
      ))}
      {/* pool */}
      <circle cx={CX} cy={CY} r="26" fill="#0c1016" stroke="#57c7ff" strokeWidth="1.5" />
      <circle cx={CX} cy={CY} r="14" fill="#57c7ff" opacity="0.85">
        <animate attributeName="r" values="13;16;13" dur="2.4s" repeatCount="indefinite" />
      </circle>
      <text
        x={CX}
        y={CY + 44}
        textAnchor="middle"
        fontSize="10"
        fill="#9fb0c0"
        fontFamily="var(--font-mono)"
        letterSpacing="2"
      >
        POOL
      </text>
      {/* agent nodes */}
      {nodes.map((node) => {
        const p = layout.get(node.account.toLowerCase());
        if (!p) return null;
        return <circle key={node.account} cx={p.x} cy={p.y} r={p.r} fill={p.color} opacity="0.9" />;
      })}
      {/* flying packets */}
      {packets.map((p) => (
        <circle key={p.id} r={p.big ? 5 : 3} fill={p.color}>
          <animate attributeName="cx" from={p.x1} to={p.x2} dur="1.1s" fill="freeze" />
          <animate attributeName="cy" from={p.y1} to={p.y2} dur="1.1s" fill="freeze" />
          <animate attributeName="opacity" values="0;1;1;0" dur="1.1s" fill="freeze" />
        </circle>
      ))}
    </svg>
  );
}
