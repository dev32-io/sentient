// ---------------------------------------------------------------------------
// Connector contract — the boundary between SDK and app-registered connectors.
// ---------------------------------------------------------------------------

import type { PresenceWiringFactory } from "./presence/presence-wiring.ts";

// Re-export presence-wiring types so external consumers can keep importing
// them from the SDK's public surface via `@sentient/web-sdk`. Canonical
// definitions live in `presence/presence-wiring.ts` (the module whose shape
// they describe). Re-exporting here avoids drift while preserving the public
// API that `index.ts` forwards.
export type { PresenceWiring, PresenceWiringFactory, PresenceWiringHooks } from "./presence/presence-wiring.ts";

/** Internal SDK surface exposed to connectors. Connectors never see WebSocket. */
export interface SentientSDKInternal {
  /** Send a typed JSON message to the gateway. */
  send(message: unknown): void;
  /** Send raw binary data (audio frames) to the gateway. */
  sendBinary(data: ArrayBuffer | Uint8Array): void;
  /** Subscribe to a WS message type. Returns unsubscribe function. */
  onMessage(type: string, handler: (msg: unknown) => void): () => void;
  /** Subscribe to binary WS messages. Returns unsubscribe function. */
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
}

/** Every connector implements this contract. */
export interface Connector {
  /** Capability string sent during session.configure (e.g. "audio.output"). */
  readonly capability: string;
  /** Direction: input sends data, output receives data, status observes. */
  readonly kind: "input" | "output" | "status";
  /** Called by SDK after session.ready — wire up message handlers here. */
  attach(sdk: SentientSDKInternal): void;
  /** Called by SDK on disconnect — tear down handlers and release resources. */
  detach(): void;
  /** Called when gateway sends connector.cancelled for this connector's capability. */
  onCancelled?(): void;
}

/**
 * Payload extracted from the `session.ready` message.
 *
 * The pre-2.0 `playback { minEagerEndMs, preemptFadeoutMs }` pair is
 * deliberately absent: both values existed only to tune the retired preempt
 * policy, and §7.2 forbids preemption outright. `createTurnAudioQueue` is a
 * strict FIFO with no tunables, so the SDK does not surface them even if a
 * gateway build still sends them.
 */
export interface SessionReadyPayload {
  sessionId: string;
  audioEncoding: string;
  inputSampleRate: number;
  outputSampleRate: number;
  enabledEffects: string[];
}

/**
 * Presence-driven lifecycle configuration. When present, the SDK constructs
 * an idle detector + presence source internally (Task 1.1 / 1.2) and uses
 * them to drive WebSocket lifecycle: close on idle, reopen on presence
 * return. When absent, presence lifecycle is disabled and the SDK behaves
 * exactly as before — the socket stays open until the consumer calls
 * `disconnect()` or the connection drops.
 *
 * This is intentionally NOT a new public `SDKStatus` value: presence-driven
 * closes surface as `disconnected` and presence-driven reopens surface as
 * `connecting → authenticating → ready`, identical to any other reconnect.
 */
export interface IdlePresenceConfig {
  /** Ms of inactivity after which the client should disconnect the WS. */
  readonly idleThresholdMs: number;
  /** Ms of inactivity after which the detector enters `warning`. Optional; defaults inside the detector. */
  readonly warningThresholdMs?: number;
  /** Period of the presence-source ticker. Drives detector.tick cadence. */
  readonly tickIntervalMs: number;
}

/**
 * Reconnect / probe tunables. Apply to unexpected WS drops, visibility-driven
 * probes, and dead-WS sendRaw fallbacks. Idle-driven (presence) close still
 * uses its own deferred-reconnect path — see PresenceCoordinator.
 */
export interface ReconnectConfig {
  /** First retry delay in ms. Subsequent attempts double until `maxMs`. */
  readonly baseMs: number;
  /** Cap on the exponential backoff delay. */
  readonly maxMs: number;
  /** Random jitter added to each computed delay to spread retries. */
  readonly jitterMs: number;
  /** Max attempts before surrendering and emitting `onConnectionLost`. */
  readonly maxAttempts: number;
  /** Ms to wait for a `pong` after sending a `ping` probe before treating WS as dead. */
  readonly probePingTimeoutMs: number;
}

/** Configuration for creating a SentientSDK instance. */
export interface SentientSDKConfig {
  /** Full WebSocket URL to the gateway (e.g. "wss://host/api/v1/ws"). */
  gatewayUrl: string;
  /** Auth token for the gateway. */
  token: string;
  /** Optional: inject a custom WebSocket constructor (for testing). */
  createWebSocket?: (url: string) => WebSocket;
  /** Called when session.ready is received, before connectors are attached.
   *  Allows consumers to read gateway-configured tunables (e.g. playback params). */
  onSessionReady?: (payload: SessionReadyPayload) => void;
  /**
   * Enables presence-driven WS lifecycle. When set, the SDK creates a
   * presence wiring and closes the WS on idle, reopens on presence return.
   * When absent, presence lifecycle is disabled (backwards-compatible).
   */
  idlePresence?: IdlePresenceConfig;
  /**
   * DI hook for the presence wiring. Primarily a test seam. Production code
   * leaves this undefined and the SDK builds the wiring from
   * `createPresenceSource` / `createIdleDetector`.
   */
  createPresenceWiring?: PresenceWiringFactory;
  /**
   * Reconnect tunables. Optional; SDK uses sensible defaults if absent.
   * Override to tune for slower or faster networks. The SDK never reconnects
   * past `maxAttempts` — after that, it emits `onConnectionLost` and waits
   * for the consumer to call `forceReconnect()` manually.
   */
  reconnect?: ReconnectConfig;
  /**
   * Called on every status transition. Use to drive UI pills, banners, and
   * input-disabled affordances. The SDK guarantees this fires AFTER the
   * internal status flip, so reading `sdk.status()` from inside is safe.
   */
  onStatusChange?: (status: SDKStatus) => void;
  /**
   * Emitted when the gateway rejects the auth token during a connect /
   * reconnect attempt. Consumer should clear stored tokens and route to
   * the login flow.
   */
  onAuthExpired?: () => void;
  /**
   * Emitted after the SDK exhausts its reconnect attempts. The WS stays
   * disconnected; consumer should surface a "Tap to reconnect" affordance
   * and, when the user opts in, call `sdk.forceReconnect()` to retry.
   */
  onConnectionLost?: () => void;
}

/**
 * SDK connection status.
 *
 * - `disconnected` — no live WS. Either initial state, idle-closed, or
 *   reconnect-exhausted.
 * - `connecting` — WS handshake in flight.
 * - `authenticating` — WS open, auth frame sent, waiting for `auth.ok`.
 * - `ready` — `session.ready` received, connectors attached, traffic flows.
 * - `reconnecting` — last connection dropped unexpectedly; SDK is in its
 *   backoff loop. Functionally close to `connecting`, but distinct so the
 *   UI can render a different pill ("Reconnecting…" vs "Connecting…").
 * - `error` — terminal auth failure or session-ready timeout. Consumer
 *   must call `forceReconnect()` to retry.
 */
export type SDKStatus = "disconnected" | "connecting" | "authenticating" | "ready" | "reconnecting" | "error";
