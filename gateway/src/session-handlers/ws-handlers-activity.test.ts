/**
 * Slice 4 — ws.in activity clock tap.
 *
 * Pins two behaviours of handleWebSocketMessage:
 *   A) A non-ping JSON frame (text.input) TOUCHES the activityClock with "ws.in".
 *   B) A ping JSON frame does NOT touch the activityClock.
 *
 * The touch happens in the `if (msg.type !== "ping")` block, before the switch,
 * so it fires regardless of whether downstream handlers succeed (e.g. textAdapter
 * being null). The ping case explicitly skips the block — keepalive is not
 * activity.
 */

import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import type { ActivityClock } from "../session/activity/activity-clock.js";
import { handleWebSocketMessage } from "./ws-handlers.js";
import { createEmptySessionData } from "./ws-helpers.js";
import type { ClientData } from "./ws-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake ActivityClock that records every touch source. */
function makeFakeClock(): ActivityClock & { touchedSources: string[] } {
  const touchedSources: string[] = [];
  return {
    touchedSources,
    touch(source) {
      touchedSources.push(source);
    },
    idleMs(nowMs: number) {
      return nowMs;
    },
    lastActivityMs() {
      return 0;
    },
  };
}

/** Minimal authed ws stub. textAdapter is null — touch fires before the switch. */
function makeWs(clock: ActivityClock): ServerWebSocket<ClientData> {
  const data = createEmptySessionData();
  data.authState = "authed";
  data.activityClock = clock;
  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as ServerWebSocket<ClientData>;
}

/** Minimal GatewayServices sufficient for the JSON routing path. */
function makeServices(): GatewayServices {
  return {} as unknown as GatewayServices;
}

// ---------------------------------------------------------------------------
// A) text.input → ws.in IS touched
// ---------------------------------------------------------------------------

describe("handleWebSocketMessage — ws.in activity clock tap", () => {
  it('touches "ws.in" when a text.input frame is received', async () => {
    const clock = makeFakeClock();
    const ws = makeWs(clock);
    const services = makeServices();

    const frame = JSON.stringify({ type: "text.input", text: "hello" });
    await handleWebSocketMessage(ws, frame, services);

    expect(clock.touchedSources).toContain("ws.in");
  });

  // -------------------------------------------------------------------------
  // B) ping → ws.in is NOT touched
  // -------------------------------------------------------------------------

  it('does NOT touch "ws.in" when a ping frame is received', async () => {
    const clock = makeFakeClock();
    const ws = makeWs(clock);
    const services = makeServices();

    const frame = JSON.stringify({ type: "ping" });
    await handleWebSocketMessage(ws, frame, services);

    expect(clock.touchedSources).not.toContain("ws.in");
    expect(clock.touchedSources).toHaveLength(0);
  });
});
