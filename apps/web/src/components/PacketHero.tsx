"use client";

/**
 * PacketHero: the thesis made visible in 3D.
 *
 * The venue is rendered as a settlement network: a central POOL node (the universal counterparty) ringed
 * by the live agent nodes. Every settlement event the engine emits this block becomes a literal PACKET
 * that flies between the agent and the pool, colored by kind:
 *   • funding      (amber)  , the continuous per-block funding stream
 *   • auto-settle  (cyan)   , the contract topping a position up from Vault collateral in `checkpoint`
 *   • margin-call  (magenta), the HEADLINE x402 Gateway nanopayment (the sub-cent off-chain payment)
 *
 * Direction encodes the cashflow sign: a packet flies agent→pool when the account pays, pool→agent when
 * it receives. So "thousands of sub-cent payments per block" stops being a sentence and becomes a swarm.
 *
 * This is pure three.js (no react-three-fiber) so the bundle stays small and the render loop is fully
 * under our control. The component is feed-driven: `events` (this block's batch) spawn packets; `nodes`
 * (the live accounts + their roles) lay out the ring. All three.js objects are created once and disposed
 * on unmount, no per-frame allocation in the hot loop beyond the bounded packet pool.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { AuthorizationKind, SettlementEvent } from "@/lib/types.ts";
import { profileFor } from "@/lib/venue.ts";

/** A node in the ring (an agent), plus the pool at center. */
export interface HeroNode {
  account: string;
  /** 0..1 size hint (notional share) for the node radius. */
  weight: number;
  /** Role accent color (CSS var resolved to hex by the caller is unnecessary, we map below). */
  role: string;
}

// Mirror the refined CSS signal tokens (globals.css) so the 3D scene speaks the same color language:
// one hue per meaning, mm distinct from pool, the dark agent muted (not neon violet).
const KIND_COLOR: Record<AuthorizationKind, number> = {
  funding: 0xffb14a,
  "auto-settle": 0x4ec5ff,
  "margin-call": 0xfb5bcf,
};

const ROLE_COLOR: Record<string, number> = {
  long: 0x62e6a0,
  short: 0xff5d79,
  mm: 0x8aa0ff, // periwinkle, distinct from the pool cyan
  funding: 0xffb14a,
  dark: 0x9a8fc4, // muted slate-violet, the agent going silent, not a neon glow
  unknown: 0x9fb0c0,
};

/** A single in-flight packet. */
interface Packet {
  mesh: THREE.Mesh;
  trail: THREE.Points;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  speed: number;
  active: boolean;
}

const MAX_PACKETS = 160;
const POOL_POS = new THREE.Vector3(0, 0, 0);
const RING_RADIUS = 4.2;

export function PacketHero({
  events,
  nodes,
  paused = false,
  onUnsupported,
}: {
  events: SettlementEvent[];
  nodes: HeroNode[];
  paused?: boolean;
  /** Called if WebGL can't initialize (headless / locked-down GPU) so the parent can show a 2D fallback. */
  onUnsupported?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{
    spawn: (e: SettlementEvent) => void;
    setNodes: (n: HeroNode[]) => void;
    setPaused: (p: boolean) => void;
  } | null>(null);

  // Stable node layout key so we only re-place the ring when the set of accounts changes.
  const nodeKey = useMemo(
    () =>
      nodes
        .map((n) => `${n.account}:${n.role}`)
        .sort()
        .join("|"),
    [nodes],
  );

  // ── three.js scene setup (once) ──────────────────────────────────────────────────
  // The scene is built once and lives for the component's lifetime; `paused`/`onUnsupported`/`nodes`
  // are pushed in imperatively via apiRef + the dedicated effects below, not by re-running setup.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time scene init (see comment above).
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07090c, 0.04);

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 5.4, 11);
    camera.lookAt(0, 0, 0);

    // WebGL may be unavailable (headless capture, locked-down GPU, ancient browser). Fail soft: tell
    // the parent to render the 2D fallback instead of letting an uncaught error blank the page.
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

    // ── Pool node (center): a glowing icosahedron + a halo ring. ──
    const poolGeo = new THREE.IcosahedronGeometry(1.05, 1);
    const poolMat = new THREE.MeshStandardMaterial({
      color: 0x57c7ff,
      emissive: 0x1f6f99,
      emissiveIntensity: 0.9,
      metalness: 0.3,
      roughness: 0.35,
      flatShading: true,
    });
    const pool = new THREE.Mesh(poolGeo, poolMat);
    scene.add(pool);

    const poolWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(poolGeo),
      new THREE.LineBasicMaterial({ color: 0x9fe6ff, transparent: true, opacity: 0.35 }),
    );
    pool.add(poolWire);

    const haloGeo = new THREE.RingGeometry(RING_RADIUS - 0.02, RING_RADIUS + 0.02, 128);
    const halo = new THREE.Mesh(
      haloGeo,
      new THREE.MeshBasicMaterial({
        color: 0x2b3645,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    scene.add(halo);

    // ── Lighting. ──
    scene.add(new THREE.AmbientLight(0x4060a0, 0.7));
    const key = new THREE.PointLight(0x57c7ff, 60, 40);
    key.position.set(0, 6, 6);
    scene.add(key);
    const rim = new THREE.PointLight(0x38f9b0, 30, 40);
    rim.position.set(-6, 2, -4);
    scene.add(rim);

    // ── Starfield backdrop (static, sparse) for depth. ──
    const starCount = 280;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 60;
      starPos[i * 3 + 1] = (Math.random() - 0.5) * 36;
      starPos[i * 3 + 2] = -10 - Math.random() * 30;
    }
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(starPos, 3)),
      new THREE.PointsMaterial({ color: 0x3a4a5e, size: 0.06, transparent: true, opacity: 0.7 }),
    );
    scene.add(stars);

    // ── Agent node group + connector lines (rebuilt on node-set change). ──
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);
    const nodeMap = new Map<string, THREE.Vector3>();

    const buildNodes = (list: HeroNode[]) => {
      // Dispose previous.
      for (const child of [...nodeGroup.children]) {
        nodeGroup.remove(child);
        disposeObject(child);
      }
      nodeMap.clear();
      const n = Math.max(list.length, 1);
      list.forEach((node, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const pos = new THREE.Vector3(
          Math.cos(angle) * RING_RADIUS,
          Math.sin(i * 1.7) * 0.35,
          Math.sin(angle) * RING_RADIUS,
        );
        nodeMap.set(node.account.toLowerCase(), pos);
        const color = ROLE_COLOR[node.role] ?? ROLE_COLOR.unknown;
        const r = 0.34 + node.weight * 0.42;

        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.55,
          metalness: 0.2,
          roughness: 0.4,
          flatShading: true,
        });
        const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(r, 0), mat);
        mesh.position.copy(pos);
        nodeGroup.add(mesh);

        // Connector spoke to the pool.
        const lineGeo = new THREE.BufferGeometry().setFromPoints([pos, POOL_POS]);
        const line = new THREE.Line(
          lineGeo,
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.12 }),
        );
        nodeGroup.add(line);
      });
    };

    // ── Packet pool (pre-allocated; recycled). ──
    const packets: Packet[] = [];
    const packetGeo = new THREE.SphereGeometry(0.085, 8, 8);
    const trailGeo = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
      return g;
    };
    for (let i = 0; i < MAX_PACKETS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
      const mesh = new THREE.Mesh(packetGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      const trail = new THREE.Points(
        trailGeo(),
        new THREE.PointsMaterial({ color: 0xffffff, size: 0.07, transparent: true, opacity: 0 }),
      );
      trail.visible = false;
      scene.add(trail);
      packets.push({
        mesh,
        trail,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: 0,
        speed: 0,
        active: false,
      });
    }

    const spawn = (e: SettlementEvent) => {
      const nodePos = nodeMap.get(e.account.toLowerCase());
      if (!nodePos) return;
      const slot = packets.find((p) => !p.active);
      if (!slot) return; // pool saturated this frame, fine, we're showing density not exactness
      const pays = Number(e.amount) < 0; // negative = account pays → agent→pool
      slot.from.copy(pays ? nodePos : POOL_POS);
      slot.to.copy(pays ? POOL_POS : nodePos);
      slot.t = 0;
      slot.speed = 0.9 + Math.random() * 0.5;
      slot.active = true;
      const color = KIND_COLOR[e.kind] ?? 0xffffff;
      (slot.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      (slot.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
      (slot.trail.material as THREE.PointsMaterial).color.setHex(color);
      (slot.trail.material as THREE.PointsMaterial).opacity = 0.6;
      // Bigger packet for the headline nanopayment so it pops in the swarm.
      const scale = e.kind === "margin-call" ? 1.7 : 1;
      slot.mesh.scale.setScalar(scale);
      slot.mesh.visible = true;
      slot.trail.visible = true;
    };

    let pausedFlag = paused;

    apiRef.current = {
      spawn,
      setNodes: buildNodes,
      setPaused: (p) => {
        pausedFlag = p;
      },
    };

    // ── Resize handling. ──
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

    // ── Render loop. ──
    const clock = new THREE.Clock();
    let raf = 0;
    const tmp = new THREE.Vector3();
    const arc = new THREE.Vector3();

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);

      // Gentle auto-orbit + pool throb.
      nodeGroup.rotation.y += dt * 0.08;
      halo.rotation.z += dt * 0.05;
      const throb = 1 + Math.sin(clock.elapsedTime * 2) * 0.03;
      pool.scale.setScalar(throb);
      pool.rotation.y += dt * 0.25;
      pool.rotation.x += dt * 0.1;

      // Advance packets along a slight upward arc (so they don't all sit on the floor plane).
      for (const p of packets) {
        if (!p.active) continue;
        p.t += dt * p.speed;
        if (p.t >= 1) {
          p.active = false;
          p.mesh.visible = false;
          p.trail.visible = false;
          continue;
        }
        tmp.lerpVectors(p.from, p.to, p.t);
        // Parabolic lift toward the midpoint.
        arc.copy(tmp);
        arc.y += Math.sin(p.t * Math.PI) * 1.1;
        p.mesh.position.copy(arc);
        // Fade in/out at the ends.
        const fade = Math.sin(p.t * Math.PI);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 + fade * 0.65;

        // Update the trail (a short tail behind the head).
        const posAttr = p.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < 6; i++) {
          const tt = Math.max(0, p.t - i * 0.04);
          tmp.lerpVectors(p.from, p.to, tt);
          posAttr.setXYZ(i, tmp.x, tmp.y + Math.sin(tt * Math.PI) * 1.1, tmp.z);
        }
        posAttr.needsUpdate = true;
      }

      if (!pausedFlag) renderer.render(scene, camera);
    };
    if (!pausedFlag) tick();

    // ── Teardown. ──
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      apiRef.current = null;
      scene.traverse(disposeObject);
      packetGeo.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  // Re-layout the ring only when the SET of accounts changes (nodeKey), not on every `nodes` identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeKey is the intended trigger, not nodes.
  useEffect(() => {
    apiRef.current?.setNodes(nodes);
  }, [nodeKey]);

  // Pause the render loop when off-screen / replay paused.
  useEffect(() => {
    apiRef.current?.setPaused(paused);
  }, [paused]);

  // Spawn packets for each new settlement event batch.
  useEffect(() => {
    if (!events.length || !apiRef.current) return;
    // Stagger spawns across a short window so a block's batch reads as a burst, not a single frame.
    events.forEach((e, i) => {
      const delay = Math.min(i * 45, 900);
      setTimeout(() => apiRef.current?.spawn(e), delay);
    });
  }, [events]);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden="true" />;
}

/** Dispose geometries/materials of an object3D (called on teardown + node rebuild). */
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

/** Map a role profile to the hero's role key (matches ROLE_COLOR). */
export function heroRole(account: string): string {
  return profileFor(account).role;
}
