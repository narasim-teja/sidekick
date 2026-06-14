"use client";

/**
 * LatticeHero: the landing page centerpiece. A bespoke, self-running three.js scene (NOT the
 * dashboard's data-fed PacketHero) that dramatizes the venue's one irreducible idea: a continuous
 * settlement lattice where thousands of sub-cent payments stream between agents and a central pool,
 * every block, forever, no human in the loop.
 *
 * What you see, and what each thing means (the scene IS the pitch):
 *   • CORE     , the pool: the universal counterparty every position settles against.
 *   • RING     , autonomous agent nodes (long/short/mm/funding/dark), each a different signal color.
 *   • PACKETS  , sub-cent settlement payments flying agent↔pool. Magenta = the x402 Gateway
 *                 nanopayment (the headline), amber = the per-block funding stream, cyan = auto-settle.
 *   • BLOCK PULSE, a ring expands from the core ~every 2s: a new Arc block. The whole venue
 *                 re-marks, re-funds, reconciles. The lattice breathes once per block.
 *   • DECREMENT, occasionally an agent node smoothly *shrinks* (no explosion): a position curing
 *                 margin by decrementing, not liquidating. The thesis, animated.
 *
 * It is purely decorative (aria-hidden) and never gates content, the headline reads over it, and a
 * static gradient shows if WebGL is unavailable. Honors prefers-reduced-motion: the render loop runs
 * a single frame and stops, so the lattice is a still composition rather than motion.
 *
 * Pure three.js (no react-three-fiber) to match the dashboard's bundle discipline; every object is
 * created once and disposed on unmount, with a bounded, recycled packet pool, no per-frame alloc.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

// Signal palette, mirrors globals.css so the scene is continuous with the rest of the identity.
const COL = {
  pool: 0x57c7ff,
  long: 0x38f9b0,
  short: 0xff5c7a,
  mm: 0x57c7ff,
  funding: 0xffb454,
  dark: 0xb388ff,
  nano: 0xff52d9,
  autoSettle: 0x57c7ff,
} as const;

// The agent ring: role drives color + a little personality (how often it pays vs receives).
const AGENTS: { role: keyof typeof COL; weight: number }[] = [
  { role: "long", weight: 1.0 },
  { role: "funding", weight: 0.78 },
  { role: "short", weight: 0.62 },
  { role: "mm", weight: 0.9 },
  { role: "dark", weight: 0.5 },
  { role: "long", weight: 0.7 },
  { role: "mm", weight: 0.55 },
  { role: "short", weight: 0.85 },
  { role: "funding", weight: 0.66 },
];

const PACKET_KINDS = [
  { color: COL.nano, weight: 0.5, scale: 1.8 }, // the headline nanopayment, most common, biggest
  { color: COL.funding, weight: 0.35, scale: 1.0 }, // funding stream
  { color: COL.autoSettle, weight: 0.15, scale: 1.0 }, // auto-settle
] as const;

const MAX_PACKETS = 220;
const RING_RADIUS = 4.4;
const POOL = new THREE.Vector3(0, 0, 0);

interface Packet {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  lift: number;
  t: number;
  speed: number;
  active: boolean;
}

function pickKind() {
  const r = Math.random();
  let acc = 0;
  for (const k of PACKET_KINDS) {
    acc += k.weight;
    if (r <= acc) return k;
  }
  return PACKET_KINDS[0];
}

export function LatticeHero({ onUnsupported }: { onUnsupported?: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time scene init.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reduceMotion =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07090c, 0.03);

    // Camera: the known-good 3/4-top view of the lattice, centered in its own canvas. Horizontal
    // composition (placing the lattice in the right portion of the hero, as a counterweight to the
    // left-aligned headline) is handled in the LAYOUT (the canvas container is offset right on wide
    // viewports) rather than by panning the camera, far more predictable than fighting the frustum.
    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
    camera.position.set(0, 4.6, 12.5);
    // Look at a point BELOW the ring so the lattice (pool core + nodes) rises into the vertical middle
    // of the canvas rather than sinking toward the bottom edge / scrim. Single-axis, composition-safe.
    camera.lookAt(0, -1.7, 0);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        failIfMajorPerformanceCaveat: false,
      });
    } catch {
      onUnsupported?.();
      return;
    }
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    // ── Pool core: a faceted icosahedron with a wireframe shell + an inner glow. ──
    const coreGeo = new THREE.IcosahedronGeometry(1.15, 1);
    const core = new THREE.Mesh(
      coreGeo,
      new THREE.MeshStandardMaterial({
        color: 0x0c1016,
        emissive: COL.pool,
        emissiveIntensity: 0.5,
        metalness: 0.5,
        roughness: 0.3,
        flatShading: true,
      }),
    );
    scene.add(core);
    const coreWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(coreGeo),
      new THREE.LineBasicMaterial({ color: 0x9fe6ff, transparent: true, opacity: 0.45 }),
    );
    core.add(coreWire);
    // Inner glow sphere.
    const coreGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 16, 16),
      new THREE.MeshBasicMaterial({ color: COL.pool, transparent: true, opacity: 0.5 }),
    );
    core.add(coreGlow);

    // ── Ground halo ring (the venue's perimeter). ──
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(RING_RADIUS - 0.015, RING_RADIUS + 0.015, 160),
      new THREE.MeshBasicMaterial({
        color: 0x2b3645,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.55,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    scene.add(halo);

    // ── Block-pulse rings: expanding rings that fire ~every block. Pre-allocated pool. ──
    const PULSES = 4;
    const pulses = Array.from({ length: PULSES }, () => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.98, 1.0, 96),
        new THREE.MeshBasicMaterial({
          color: COL.pool,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      scene.add(m);
      return { mesh: m, t: 1, active: false };
    });

    // ── Lighting. ──
    scene.add(new THREE.AmbientLight(0x3a5680, 0.8));
    const key = new THREE.PointLight(0x57c7ff, 70, 44);
    key.position.set(2, 7, 7);
    scene.add(key);
    const rim = new THREE.PointLight(0x38f9b0, 34, 44);
    rim.position.set(-7, 2, -5);
    scene.add(rim);
    const warm = new THREE.PointLight(0xffb454, 22, 40);
    warm.position.set(5, -2, 3);
    scene.add(warm);

    // ── Starfield (depth). ──
    const starCount = 360;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 70;
      starPos[i * 3 + 1] = (Math.random() - 0.5) * 42;
      starPos[i * 3 + 2] = -12 - Math.random() * 34;
    }
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(starPos, 3)),
      new THREE.PointsMaterial({ color: 0x3a4a5e, size: 0.07, transparent: true, opacity: 0.7 }),
    );
    scene.add(stars);

    // ── Agent nodes + spokes (built once). Each node tracks a live `scale` so it can decrement. ──
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);
    interface AgentNode {
      mesh: THREE.Mesh;
      pos: THREE.Vector3;
      baseR: number;
      scale: number;
      targetScale: number;
      color: number;
    }
    const nodes: AgentNode[] = [];
    const n = AGENTS.length;
    AGENTS.forEach((a, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const pos = new THREE.Vector3(
        Math.cos(angle) * RING_RADIUS,
        Math.sin(i * 1.9) * 0.45,
        Math.sin(angle) * RING_RADIUS,
      );
      const color = COL[a.role];
      const baseR = 0.3 + a.weight * 0.34;
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(baseR, 0),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.6,
          metalness: 0.25,
          roughness: 0.38,
          flatShading: true,
        }),
      );
      mesh.position.copy(pos);
      nodeGroup.add(mesh);
      // Hairline spoke to the core.
      const spoke = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([pos, POOL]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.14 }),
      );
      nodeGroup.add(spoke);
      nodes.push({ mesh, pos, baseR, scale: 1, targetScale: 1, color });
    });

    // ── Packet pool (recycled). ──
    const packets: Packet[] = [];
    const packetGeo = new THREE.SphereGeometry(0.09, 8, 8);
    for (let i = 0; i < MAX_PACKETS; i++) {
      const mesh = new THREE.Mesh(
        packetGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
      );
      mesh.visible = false;
      scene.add(mesh);
      packets.push({
        mesh,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        lift: 1,
        t: 0,
        speed: 1,
        active: false,
      });
    }

    const spawnPacket = () => {
      const slot = packets.find((p) => !p.active);
      if (!slot) return;
      const node = nodes[Math.floor(Math.random() * nodes.length)];
      if (!node) return;
      const pays = Math.random() < 0.5; // agent→pool when it pays, pool→agent when it receives
      slot.from.copy(pays ? node.pos : POOL);
      slot.to.copy(pays ? POOL : node.pos);
      slot.t = 0;
      slot.speed = 0.55 + Math.random() * 0.5;
      slot.lift = 0.6 + Math.random() * 1.2;
      slot.active = true;
      const kind = pickKind();
      const mat = slot.mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(kind.color);
      mat.opacity = 1;
      slot.mesh.scale.setScalar(kind.scale);
      slot.mesh.visible = true;
    };

    const firePulse = () => {
      const slot = pulses.find((p) => !p.active);
      if (!slot) return;
      slot.t = 0;
      slot.active = true;
      slot.mesh.visible = true;
    };

    const triggerDecrement = () => {
      // Pick a node above ~0.6 scale and smoothly shrink it (no explosion), then later regrow.
      const candidates = nodes.filter((nd) => nd.targetScale > 0.62);
      if (!candidates.length) return;
      const nd = candidates[Math.floor(Math.random() * candidates.length)];
      if (!nd) return;
      nd.targetScale = 0.42 + Math.random() * 0.12;
      // Regrow after a beat, the agent re-opens / cures and the lattice heals.
      globalThis.setTimeout(() => {
        nd.targetScale = 0.85 + Math.random() * 0.15;
      }, 2600);
    };

    // ── Resize. ──
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // ── Pause when the tab is hidden. ──
    let hidden = document.hidden;
    const onVis = () => {
      hidden = document.hidden;
      if (!hidden && !reduceMotion) clock.getDelta(); // drop the accumulated gap so packets don't jump
    };
    document.addEventListener("visibilitychange", onVis);

    // ── Loop / timers. ──
    const clock = new THREE.Clock();
    let raf = 0;
    const tmp = new THREE.Vector3();
    let blockTimer = 0;
    const BLOCK_PERIOD = 2.0; // Arc ~2s blocks
    let spawnTimer = 0;

    const renderOnce = () => renderer.render(scene, camera);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (hidden) return;
      const dt = Math.min(clock.getDelta(), 0.05);

      // Continuous gentle motion.
      nodeGroup.rotation.y += dt * 0.07;
      halo.rotation.z += dt * 0.04;
      core.rotation.y += dt * 0.22;
      core.rotation.x += dt * 0.09;
      const throb = 1 + Math.sin(clock.elapsedTime * 1.8) * 0.035;
      core.scale.setScalar(throb);
      (coreGlow.material as THREE.MeshBasicMaterial).opacity =
        0.4 + Math.sin(clock.elapsedTime * 2.4) * 0.12;
      stars.rotation.y += dt * 0.006;

      // Block cadence: fire a pulse + a decrement-chance once per ~block.
      blockTimer += dt;
      if (blockTimer >= BLOCK_PERIOD) {
        blockTimer -= BLOCK_PERIOD;
        firePulse();
        if (Math.random() < 0.35) triggerDecrement();
      }

      // Continuous packet stream, many sub-cent payments between blocks.
      spawnTimer += dt;
      const spawnEvery = 0.035; // ~28 packets/sec → a dense but legible swarm
      while (spawnTimer >= spawnEvery) {
        spawnTimer -= spawnEvery;
        spawnPacket();
      }

      // Advance packets along an arc.
      for (const p of packets) {
        if (!p.active) continue;
        p.t += dt * p.speed;
        if (p.t >= 1) {
          p.active = false;
          p.mesh.visible = false;
          continue;
        }
        tmp.lerpVectors(p.from, p.to, p.t);
        tmp.y += Math.sin(p.t * Math.PI) * p.lift;
        p.mesh.position.copy(tmp);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.3 + Math.sin(p.t * Math.PI) * 0.7;
      }

      // Block-pulse rings expand + fade.
      for (const pl of pulses) {
        if (!pl.active) continue;
        pl.t += dt * 0.6;
        if (pl.t >= 1) {
          pl.active = false;
          pl.mesh.visible = false;
          continue;
        }
        const s = 1 + pl.t * (RING_RADIUS + 1.5);
        pl.mesh.scale.set(s, s, s);
        (pl.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - pl.t) * 0.5;
      }

      // Ease node scales toward their target (smooth decrement / regrow).
      for (const nd of nodes) {
        nd.scale += (nd.targetScale - nd.scale) * Math.min(1, dt * 3.2);
        nd.mesh.scale.setScalar(nd.scale);
      }

      renderOnce();
    };

    if (reduceMotion) {
      // Static composition: lay out a representative still frame, render once, stop.
      for (let i = 0; i < 60; i++) spawnPacket();
      for (const p of packets) {
        if (!p.active) continue;
        p.t = 0.5;
        tmp.lerpVectors(p.from, p.to, p.t);
        tmp.y += Math.sin(p.t * Math.PI) * p.lift;
        p.mesh.position.copy(tmp);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
      }
      renderOnce();
    } else {
      tick();
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      scene.traverse(disposeObject);
      packetGeo.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden="true" />;
}

function disposeObject(obj: THREE.Object3D): void {
  const mesh = obj as THREE.Mesh;
  if (mesh.geometry) mesh.geometry.dispose();
  const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
  if (Array.isArray(mat)) {
    for (const m of mat) m.dispose();
  } else if (mat) {
    mat.dispose();
  }
}
