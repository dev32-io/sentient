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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connector } from "./connector-types.ts";
import { CURRENT_SESSION_STORAGE_KEY } from "./sdk-reconnect.ts";
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

// ---------------------------------------------------------------------------
// The per-tab session pointer, driven by the frames that actually decide it.
//
// WIRE CONTRACT (gateway↔SDK). The tab presents `conversationId` on
// `session.configure` and the gateway answers with exactly one of two frames:
// `session.attached` (membership honoured) or `session.draft` (refused). This
// pins that mapping end-to-end, through the real handler wiring, because the
// defect it replaces lived in the wiring rather than in any one function: a
// ~200ms timer armed on `conversation.snapshot` deleted the stored id unless a
// `session.switched` disarmed it — and a plain reload confirms with
// `session.attached` and never sends `switched`, so the pointer was dropped
// right after it resolved CORRECTLY, and the conversation was lost on the next
// reconnect.
// ---------------------------------------------------------------------------

/** A socket the test drives: frames in via `deliver`, frames out into `sent`. */
interface DrivableSocket {
  readonly socket: WebSocket;
  readonly sent: Record<string, unknown>[];
  deliver(frame: Record<string, unknown>): void;
  open(): void;
}

/** `WebSocket.readyState` OPEN — `sendRaw` drops (and kicks a reconnect) below it. */
const WS_OPEN = 1;

function createDrivableSocket(): DrivableSocket {
  const sent: Record<string, unknown>[] = [];
  const socket = {
    binaryType: "blob",
    readyState: WS_OPEN,
    close(): void {},
    send(data: string): void {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
  } as unknown as WebSocket;
  return {
    socket,
    sent,
    open() {
      socket.onopen?.({} as Event);
    },
    deliver(frame) {
      socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
    },
  };
}

function installSessionStorageShim(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const SESSION_ID = "s_1111111111111111111111111111111";
const DRAFT_KEY = "d_2222222222222222222222222222222";

describe("SentientSDK — the per-tab session pointer", () => {
  let sdk: SentientSDK | null = null;
  let wire: DrivableSocket;

  /** Connect and run the handshake as far as the configure this tab presents. */
  function handshake(): void {
    wire = createDrivableSocket();
    sdk = new SentientSDK({
      gatewayUrl: "wss://gateway.test/api/v1/ws",
      token: "test-token",
      createWebSocket: () => wire.socket,
    });
    sdk.connect().catch(() => {
      /* never settles in these cases — the pointer is decided before ready */
    });
    wire.open();
    wire.deliver({ type: "auth.ok" });
  }

  function presented(): unknown {
    return wire.sent.find((f) => f.type === "session.configure")?.conversationId;
  }

  function stored(): string | null {
    return sessionStorage.getItem(CURRENT_SESSION_STORAGE_KEY);
  }

  beforeEach(() => {
    installSessionStorageShim();
  });

  afterEach(() => {
    sdk?.disconnect();
    sdk = null;
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  it("keeps the presented id when the gateway answers session.attached", () => {
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, SESSION_ID);

    handshake();
    expect(presented()).toBe(SESSION_ID);
    wire.deliver({ type: "session.attached", sessionId: SESSION_ID, generation: 1 });

    expect(stored()).toBe(SESSION_ID);
  });

  it("REGRESSION: a plain reload keeps the id — the snapshot that follows attach is not a refusal", async () => {
    // The exact reload sequence: attached → ready → snapshot, with no
    // `session.switched` anywhere in it. The deleted timer fired ~200ms after
    // the snapshot and dropped the id here, so the NEXT reconnect presented
    // nothing and the tab landed in a new empty chat.
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, SESSION_ID);

    handshake();
    wire.deliver({ type: "session.attached", sessionId: SESSION_ID, generation: 1 });
    wire.deliver({ type: "session.ready", sessionId: "conn-1" });
    wire.deliver({ type: "conversation.snapshot", entries: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(stored()).toBe(SESSION_ID);
  });

  it("drops the presented id when the gateway refuses it with session.draft", () => {
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, SESSION_ID);

    handshake();
    expect(presented()).toBe(SESSION_ID);
    wire.deliver({ type: "session.draft", draftKey: DRAFT_KEY });

    // The refused id is gone; the draft key the tab now re-presents took its place.
    expect(stored()).not.toBe(SESSION_ID);
    expect(stored()).toBe(DRAFT_KEY);
  });

  it("keeps an unspent draft across a reload — the gateway hands the same key back", () => {
    // Open a tab, press "+", reload before typing. The tab presents its draft
    // key and the gateway answers `draft.resumed` with the SAME key, which is
    // what keeps the mint idempotent: the first message still mints under the
    // key the client already holds.
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, DRAFT_KEY);

    handshake();
    expect(presented()).toBe(DRAFT_KEY);
    wire.deliver({ type: "session.draft", draftKey: DRAFT_KEY });

    expect(stored()).toBe(DRAFT_KEY);
  });

  it("a first-ever connect presents nothing and its session.draft deletes nothing", () => {
    handshake();
    expect(presented()).toBeUndefined();

    expect(() => wire.deliver({ type: "session.draft", draftKey: DRAFT_KEY })).not.toThrow();
    expect(stored()).toBe(DRAFT_KEY);
  });

  it("keeps the id when the drawer path answers session.switched", () => {
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, SESSION_ID);

    handshake();
    wire.deliver({ type: "session.switched", sessionId: SESSION_ID, ts: 1 });

    expect(stored()).toBe(SESSION_ID);
  });
});
