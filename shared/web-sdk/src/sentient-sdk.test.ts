// ---------------------------------------------------------------------------
// sentient-sdk — connector session-state lifecycle.
//
// Pins the FSM invariant that the reconnect path depends on: `detach` is
// TRANSPORT teardown and happens on every reconnect, while `reset` is SESSION
// teardown and happens only when the consumer disconnects. A `recovered:true`
// resume replays just the missed frames and sends no conversation.snapshot, so
// a reset on the reconnect path would leave the conversation mirror with
// nothing to refill it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { Connector } from "./connector-types.ts";
import { SentientSDK } from "./sentient-sdk.ts";

class SpyConnector implements Connector {
  readonly capability = "spy.capability";
  readonly kind = "status" as const;
  attaches = 0;
  detaches = 0;
  resets = 0;

  attach(): void {
    this.attaches += 1;
  }
  detach(): void {
    this.detaches += 1;
  }
  reset(): void {
    this.resets += 1;
  }
}

/** Socket stub that never opens — enough for the lifecycle paths under test. */
function createInertWebSocket(): WebSocket {
  return { binaryType: "blob", readyState: 0, close(): void {}, send(): void {} } as unknown as WebSocket;
}

function createSdk(): SentientSDK {
  return new SentientSDK({
    gatewayUrl: "wss://gateway.test/api/v1/ws",
    token: "test-token",
    createWebSocket: () => createInertWebSocket(),
  });
}

describe("SentientSDK — connector session-state lifecycle", () => {
  it("resets connector session state on a consumer-driven disconnect", () => {
    const sdk = createSdk();
    const connector = new SpyConnector();
    sdk.register(connector);

    sdk.disconnect();

    expect(connector.resets).toBe(1);
    expect(connector.detaches).toBe(1);
  });

  it("does not reset connector session state when a connect cycle re-detaches", () => {
    const sdk = createSdk();
    const connector = new SpyConnector();
    sdk.register(connector);

    void sdk.connect(); // never settles — the stub socket fires no events

    expect(connector.detaches).toBeGreaterThan(0);
    expect(connector.resets).toBe(0);
  });
});
