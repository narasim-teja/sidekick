/**
 * `BlockStream` — the WebSocket subscription behind `SideKick.on("block", …)`. The engine pushes
 * `{ type: "block", state }` frames each ~2s Arc block (and a `{ type: "hello" }` on connect); this
 * fans those out to registered handlers and auto-reconnects so an agent's loop survives a dropped
 * socket without bespoke retry logic.
 *
 * One socket is shared across all handlers on a client. Uses the platform `WebSocket` (Bun/Node 22+/
 * browser all provide it as a global), so no ws dependency.
 *
 * @see packages/engine/src/index.ts (the Bun.serve websocket bridge that emits these frames)
 */

import type { MarketBlockState } from "./types.ts";

type Frame =
  | { type: "block"; state: MarketBlockState }
  | { type: "hello"; version: string }
  | Record<string, unknown>;

export class BlockStream {
  private ws?: WebSocket;
  private readonly handlers = new Set<(s: MarketBlockState) => void>();
  private closed = false;
  /** True while a socket is opening (between `new WebSocket` and onopen/onclose) — guards against duplicate connects. */
  private connecting = false;
  private reconnectMs = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly url: string) {}

  /** Register a handler; opens the socket on the first one. Returns an unsubscribe fn. */
  on(handler: (s: MarketBlockState) => void): () => void {
    this.handlers.add(handler);
    // Only kick a connect if no socket is open AND none is already in flight (incl. a pending
    // reconnect during the backoff window) — otherwise a handler added mid-backoff spawns a second
    // concurrent socket, and every block frame gets delivered twice.
    if (!this.ws && !this.connecting) this.connect();
    return () => {
      this.handlers.delete(handler);
    };
  }

  private connect(): void {
    if (this.closed || this.connecting || this.ws) return;
    // A connect supersedes any scheduled reconnect — cancel the pending timer so it can't open a
    // second socket after this one.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connecting = true;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connecting = false;
      this.reconnectMs = 1000; // reset backoff on a healthy connect
    };
    ws.onmessage = (ev: MessageEvent) => {
      let frame: Frame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return; // ignore non-JSON frames
      }
      if (frame && (frame as { type?: string }).type === "block") {
        const state = (frame as { state: MarketBlockState }).state;
        for (const h of this.handlers) {
          try {
            h(state);
          } catch {
            /* a handler throwing must not kill the stream */
          }
        }
      }
    };
    ws.onclose = () => {
      this.connecting = false;
      this.ws = undefined;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; reconnect is scheduled there. Closing here avoids a dangling socket.
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.handlers.size === 0) return;
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, 15_000); // capped exponential backoff
  }

  /** Close the socket and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.handlers.clear();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = undefined;
  }
}
