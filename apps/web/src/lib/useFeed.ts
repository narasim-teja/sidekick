"use client";

/**
 * `useFeed` — the dashboard's single data source.
 *
 * It first tries the LIVE engine: a `/state` REST snapshot to paint immediately, then the `/ws`
 * stream for per-block pushes. If the engine is unreachable within {@link LIVE_PROBE_TIMEOUT_MS}, it
 * transparently switches to REPLAY mode and drives {@link DemoReplay} on the Arc block cadence, so the
 * UI is never blank. If a live socket later drops for good, it degrades to replay rather than freezing.
 *
 * Returns the latest {@link MarketBlockState} per market, an ordered settlement feed (accumulated
 * across blocks for the stream/3D view), the feed {@link FeedMode}, and the engine {@link EngineStatus}
 * / {@link VenueDescriptor} when live. All consumers read this one hook — there is no other I/O.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { engineUrl, engineWsUrl, LIVE_PROBE_TIMEOUT_MS, REPLAY_BLOCK_MS } from "./config.ts";
import { DemoReplay } from "./replay.ts";
import type {
  EngineFrame,
  EngineStatus,
  FeedMode,
  MarketBlockState,
  SettlementEvent,
  VenueDescriptor,
} from "./types.ts";

/** Max settlement events retained for the live stream / 3D packet feed. */
const FEED_CAP = 240;

export interface Feed {
  mode: FeedMode;
  /** Latest state per market symbol. */
  states: Record<string, MarketBlockState>;
  /** All markets the feed has seen state for (for the market selector). */
  markets: string[];
  /** The market the dashboard is focused on. */
  focusMarket: string | undefined;
  /** Switch the focused market (only meaningful when >1 market is running). */
  selectMarket: (m: string) => void;
  /** The focused market's latest state. */
  focus: MarketBlockState | undefined;
  /** Accumulated settlement events for the focused market (newest last), capped. */
  feed: SettlementEvent[];
  /** The most recent batch of settlement events for the focused market — for spawning packets. */
  lastEvents: SettlementEvent[];
  status: EngineStatus | undefined;
  venue: VenueDescriptor | undefined;
  /** Engine REST base (for explorer / debug links). */
  engineUrl: string;
}

export function useFeed(): Feed {
  const [mode, setMode] = useState<FeedMode>("connecting");
  const [states, setStates] = useState<Record<string, MarketBlockState>>({});
  // Settlement feed + last-block batch, keyed by market so the stream/3D reflect the focused market.
  const [feedByMarket, setFeedByMarket] = useState<Record<string, SettlementEvent[]>>({});
  const [lastByMarket, setLastByMarket] = useState<Record<string, SettlementEvent[]>>({});
  const [status, setStatus] = useState<EngineStatus | undefined>();
  const [venue, setVenue] = useState<VenueDescriptor | undefined>();
  const [picked, setPicked] = useState<string | undefined>();

  // Refs that must survive re-renders without re-subscribing.
  const wsRef = useRef<WebSocket | null>(null);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveSeen = useRef(false);
  const teardown = useRef(false);
  // Dedup settlement events per market by (block, account, kind, amount) so a REST snapshot + WS
  // overlap doesn't double-spawn packets.
  const seenKeys = useRef<Map<string, Set<string>>>(new Map());

  /** Merge a new market state in and append its (deduped) settlement events to that market's feed. */
  const ingest = useCallback((state: MarketBlockState) => {
    setStates((prev) => ({ ...prev, [state.market]: state }));
    let seen = seenKeys.current.get(state.market);
    if (!seen) {
      seen = new Set();
      seenKeys.current.set(state.market, seen);
    }
    const fresh: SettlementEvent[] = [];
    for (const e of state.settlement) {
      const key = `${e.block}:${e.account}:${e.kind}:${e.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(e);
    }
    if (fresh.length) {
      setLastByMarket((prev) => ({ ...prev, [state.market]: fresh }));
      setFeedByMarket((prev) => {
        const next = [...(prev[state.market] ?? []), ...fresh];
        return { ...prev, [state.market]: next.length > FEED_CAP ? next.slice(-FEED_CAP) : next };
      });
      // Bound the per-market dedup set so it can't grow forever in a long live session.
      if (seen.size > FEED_CAP * 4) {
        seenKeys.current.set(
          state.market,
          new Set(fresh.map((e) => `${e.block}:${e.account}:${e.kind}:${e.amount}`)),
        );
      }
    }
  }, []);

  /** Start the deterministic replay loop (the offline fallback). */
  const startReplay = useCallback(() => {
    if (replayTimer.current || teardown.current) return;
    setMode("replay");
    const replay = new DemoReplay();
    // Prime a handful of blocks so the first paint already shows an active venue.
    for (let i = 0; i < 9; i++) ingest(replay.step());
    replayTimer.current = setInterval(() => {
      if (teardown.current) return;
      ingest(replay.step());
    }, REPLAY_BLOCK_MS);
  }, [ingest]);

  useEffect(() => {
    teardown.current = false;
    let probeTimer: ReturnType<typeof setTimeout> | null = null;

    const base = engineUrl();

    // 1. REST bootstrap — paint immediately if the engine is up; also confirms liveness.
    const bootstrap = async () => {
      try {
        const [stateRes, statusRes, venueRes] = await Promise.all([
          fetch(`${base}/state`, { cache: "no-store" }),
          fetch(`${base}/status`, { cache: "no-store" }),
          fetch(`${base}/venue`, { cache: "no-store" }),
        ]);
        if (!stateRes.ok) throw new Error(`/state ${stateRes.status}`);
        const snapshot = (await stateRes.json()) as MarketBlockState[];
        if (statusRes.ok) setStatus((await statusRes.json()) as EngineStatus);
        if (venueRes.ok) setVenue((await venueRes.json()) as VenueDescriptor);
        markLive();
        for (const s of snapshot) ingest(s);
      } catch {
        // Engine REST not reachable — the WS attempt + probe timer decide the fallback.
      }
    };

    const markLive = () => {
      if (teardown.current) return;
      liveSeen.current = true;
      if (replayTimer.current) {
        clearInterval(replayTimer.current);
        replayTimer.current = null;
      }
      setMode("live");
    };

    // 2. WS stream — the per-block heartbeat.
    const connectWs = () => {
      if (teardown.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(engineWsUrl());
      } catch {
        return; // invalid URL / unsupported — replay fallback handles it
      }
      wsRef.current = ws;
      ws.onopen = () => markLive();
      ws.onmessage = (ev) => {
        let frame: EngineFrame;
        try {
          frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if ((frame as { type?: string }).type === "block") {
          markLive();
          ingest((frame as { state: MarketBlockState }).state);
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (teardown.current) return;
        // If we never saw the engine, the probe timer already started replay. If we WERE live and
        // the socket dropped, retry once shortly; if it keeps failing, replay takes over.
        if (liveSeen.current) {
          setTimeout(() => {
            if (!teardown.current && !wsRef.current) connectWs();
          }, 1500);
        }
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
    };

    void bootstrap();
    connectWs();

    // 3. Probe timer — if nothing live arrived in time, fall back to the demo replay.
    probeTimer = setTimeout(() => {
      if (!teardown.current && !liveSeen.current) startReplay();
    }, LIVE_PROBE_TIMEOUT_MS);

    return () => {
      teardown.current = true;
      if (probeTimer) clearTimeout(probeTimer);
      if (replayTimer.current) clearInterval(replayTimer.current);
      replayTimer.current = null;
      try {
        wsRef.current?.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
    };
  }, [ingest, startReplay]);

  // Markets ordered by the engine's running list when available, else discovery order.
  const markets = useMemo(() => {
    const seen = status?.markets?.filter((m) => states[m]) ?? [];
    for (const m of Object.keys(states)) if (!seen.includes(m)) seen.push(m);
    return seen;
  }, [status, states]);

  // The focused market: the user's pick if it still has state, else the first running market.
  const focusMarket = useMemo(() => {
    if (picked && states[picked]) return picked;
    return markets[0];
  }, [picked, states, markets]);

  const focus = focusMarket ? states[focusMarket] : undefined;
  const feed = focusMarket ? (feedByMarket[focusMarket] ?? EMPTY) : EMPTY;
  const lastEvents = focusMarket ? (lastByMarket[focusMarket] ?? EMPTY) : EMPTY;

  return {
    mode,
    states,
    markets,
    focusMarket,
    selectMarket: setPicked,
    focus,
    feed,
    lastEvents,
    status,
    venue,
    engineUrl: engineUrl(),
  };
}

/** Stable empty array so consumers don't re-render on identity churn when a market has no feed yet. */
const EMPTY: SettlementEvent[] = [];
