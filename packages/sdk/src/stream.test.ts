/**
 * Tests for BlockStream (stream.ts) — the WS subscription with auto-reconnect. The key property to
 * pin is the **single-socket invariant**: adding a handler must never spawn a second concurrent
 * socket (which would deliver every block frame twice), including during the reconnect-backoff window.
 * We stub the global `WebSocket` with a controllable fake to count how many sockets get created.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BlockStream } from "./stream.ts";

/** A minimal controllable WebSocket double. Records instances; lets the test drive open/message/close. */
class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  open(): void {
    this.onopen?.();
  }
  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(): void {
    this.closed = true;
    this.onclose?.();
  }
  close(): void {
    this.closed = true;
  }
}

const RealWS = globalThis.WebSocket;

beforeEach(() => {
  FakeWS.instances = [];
  // @ts-expect-error swap the global for the fake in tests
  globalThis.WebSocket = FakeWS;
});
afterEach(() => {
  globalThis.WebSocket = RealWS;
});

describe("BlockStream", () => {
  test("opens exactly one socket for multiple handlers", () => {
    const s = new BlockStream("ws://x/ws");
    s.on(() => {});
    s.on(() => {});
    s.on(() => {});
    expect(FakeWS.instances).toHaveLength(1);
    s.close();
  });

  test("delivers only `block` frames, to every handler, once each", () => {
    const s = new BlockStream("ws://x/ws");
    const got: string[] = [];
    s.on((state) => got.push(`a:${state.tick}`));
    s.on((state) => got.push(`b:${state.tick}`));
    const ws = FakeWS.instances[0];
    ws?.open();
    ws?.message({ type: "hello", version: "1" }); // ignored
    ws?.message({ type: "block", state: { tick: 7 } });
    expect(got.sort()).toEqual(["a:7", "b:7"]);
    s.close();
  });

  test("keeps at most one LIVE socket when a handler is added during the reconnect window", async () => {
    const s = new BlockStream("ws://x/ws");
    s.on(() => {});
    FakeWS.instances[0]?.open();
    // Drop the socket → schedules a reconnect timer (this.ws undefined, this.connecting false).
    FakeWS.instances[0]?.drop();
    // Adding a handler in this window may open a fresh socket, but it must CANCEL the pending timer
    // so no SECOND socket appears when the timer would have fired — never two live at once.
    s.on(() => {});
    // Give the (now-cancelled) reconnect timer a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 1100));
    const live = FakeWS.instances.filter((w) => !w.closed);
    expect(live).toHaveLength(1); // exactly one live socket — no duplicate from a leftover timer
    s.close();
  });

  test("close() stops further reconnects", () => {
    const s = new BlockStream("ws://x/ws");
    s.on(() => {});
    s.close();
    FakeWS.instances[0]?.drop(); // a drop after close must not reconnect
    expect(FakeWS.instances).toHaveLength(1);
  });
});
