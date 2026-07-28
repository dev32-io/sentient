// SttSession (spec §6) — the per-connection owner of one STTAdapter.
//
// Inbound binary WS frames (mic audio) land here via `pushFrame`; STT's
// transcript events leave here as `runtime.submit({kind:"conversational"})`
// — the SAME stimulus seam `text.input` uses (ws-handlers.ts), so a spoken
// message and a typed message are indistinguishable to the ReAct loop.
// STT's `turn_started` (mic onset) is the barge-in trigger (spec §4.7):
// this is the ONLY production caller of `runtime.bargeIn()`.
//
// Connection policy — deliberately lean, no reconnect supervisor:
//   - Nothing is dialed until the client's first `audio.start`, so a
//     text-only browser tab never opens a socket to the STT service.
//   - `open()` failure is logged and left; the next `audio.start` (or the
//     next mic frame while the mic is open) retries. Frames arrive every
//     ~20-60ms, so a mid-session STT drop self-heals within one frame plus
//     connect time — no timers, no backoff constants, no new config.
//   - `setTurnMode` is replayed after every successful connect: a fresh STT
//     socket is implicitly "semantic" server-side. The adapter dedups
//     internally (local-stt-adapter.ts, tuned — never modify).
//
// Failure containment: every promise this file starts is detached — nothing
// awaits it. `STTAdapter`'s contract lets `events()` reject and `close()`
// reject, so an unguarded detached promise turns one session's STT socket
// error into a process-level `unhandledRejection` that kills the gateway for
// every other session. All detached work goes through `detach()` below, and
// the event loop keeps its own `catch` so a dead stream reads as a disconnect
// (adapter cleared → the next mic frame re-dials), not as a crash.

import type { TurnMode } from "@sentient/protocol";
import type { STTAdapter, STTAdapterConfig, STTAdapterFactory, STTEvent } from "../adapters/stt/stt-adapter-types.js";
import { getLog } from "../logging/logger.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";

const log = getLog(["sentient", "session-handlers", "stt-session"]);

/** STT's own server-side default — the mode a freshly connected socket is in. */
const INITIAL_TURN_MODE: TurnMode = "semantic";

export interface SttSession {
  /** Client `audio.start` — ensure a connection and relay the turn mode. */
  start(turnMode: TurnMode): void;
  /** Client `audio.end` — force-finalize any open STT turn. */
  end(): void;
  /** One inbound binary WS frame (mic audio, opus or pcm16 per config). */
  pushFrame(bytes: Uint8Array): void;
  /** Echo-suppression window (ms). `0` clears it. See mic-echo-guard.ts. */
  suppressInputFor(ms: number): void;
  /** Connection teardown — idempotent. */
  close(): void;
}

export interface SttSessionDeps {
  readonly sessionId: string;
  readonly factory: STTAdapterFactory;
  readonly config: STTAdapterConfig;
  /** Read fresh on every event: `session.configure` can re-mint the runtime. */
  readonly getRuntime: () => SessionRuntime | null;
}

export function createSttSession(deps: SttSessionDeps): SttSession {
  const { sessionId, factory, config, getRuntime } = deps;
  const lifetime = new AbortController();

  let adapter: STTAdapter | null = null;
  let connecting = false;
  let closed = false;
  let micOpen = false;
  let desiredTurnMode: TurnMode = INITIAL_TURN_MODE;

  /**
   * Start detached background work with a rejection handler already attached.
   * Sync throws are caught too: `close()` is `Promise<void>` on the interface,
   * but nothing forces an implementation to be `async`. Never rethrows — the
   * whole point is that a failing STT socket cannot escape this session.
   */
  function detach(op: string, work: () => Promise<void>): void {
    const onFailed = (err: unknown): void => {
      log.warn("stt.detached-failed", {
        sessionId,
        op,
        reason: err instanceof Error ? err.message : String(err),
      });
    };
    try {
      work().catch(onFailed);
    } catch (err: unknown) {
      onFailed(err);
    }
  }

  function dispatch(event: STTEvent): void {
    const runtime = getRuntime();
    if (event.type === "turn_dropped") {
      log.debug("stt.turn-dropped", { sessionId, turnIdx: event.turnIdx });
      return;
    }
    if (!runtime) {
      log.warn("stt.event.no-runtime", {
        sessionId,
        eventType: event.type,
        reason: "orchestrator unconfigured, or session.configure has not minted a runtime",
      });
      return;
    }
    if (event.type === "turn_started") {
      // Barge-in (spec §4.7): fire on mic onset, BEFORE the transcript lands,
      // so the assistant stops talking as early as possible. Background tasks
      // keep running — that distinction lives in cancellation.ts.
      log.info("stt.barge-in", { sessionId, turnIdx: event.turnIdx });
      runtime.bargeIn();
      return;
    }
    const text = event.text.trim();
    if (text.length === 0) {
      log.debug("stt.transcript.blank", { sessionId, turnIdx: event.turnIdx, reason: "empty after trim" });
      return;
    }
    log.info("stt.transcript.submit", { sessionId, turnIdx: event.turnIdx, length: text.length });
    runtime.submit({ kind: "conversational", text });
  }

  async function consumeEvents(active: STTAdapter): Promise<void> {
    try {
      for await (const event of active.events(lifetime.signal)) {
        // A hook throw must never kill the event loop for the rest of the
        // session — the pre-purge adapter learned this the hard way.
        try {
          dispatch(event);
        } catch (err: unknown) {
          log.warn("stt.event.dispatch-failed", {
            sessionId,
            eventType: event.type,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err: unknown) {
      // The event stream itself failed (a socket error the adapter surfaced as
      // a throw rather than a clean return). That is a disconnect, not a fatal
      // condition: `finally` clears the adapter, so the next mic frame re-dials.
      log.warn("stt.events.failed", {
        sessionId,
        micOpen,
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (adapter === active) {
        adapter = null;
        log.info("stt.disconnected", { sessionId, micOpen, reason: "event stream ended" });
      }
    }
  }

  function connect(): void {
    if (closed || connecting || adapter !== null) return;
    connecting = true;
    const candidate = factory(config);
    log.info("stt.connecting", { sessionId, url: config.url, audioFormat: config.audioFormat });
    candidate
      .open(lifetime.signal)
      .then(() => {
        connecting = false;
        if (closed) {
          detach("close-after-session-closed", () => candidate.close());
          return;
        }
        adapter = candidate;
        candidate.setTurnMode(desiredTurnMode);
        log.info("stt.connected", { sessionId, turnMode: desiredTurnMode });
        detach("consume-events", () => consumeEvents(candidate));
      })
      .catch((err: unknown) => {
        connecting = false;
        log.warn("stt.connect-failed", {
          sessionId,
          url: config.url,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return {
    start(turnMode) {
      if (closed) return;
      micOpen = true;
      desiredTurnMode = turnMode;
      log.info("stt.audio-start", { sessionId, turnMode, connected: adapter !== null });
      if (adapter) {
        adapter.setTurnMode(turnMode);
        return;
      }
      connect();
    },

    end() {
      micOpen = false;
      log.info("stt.audio-end", { sessionId, connected: adapter !== null });
      adapter?.endUtterance();
    },

    pushFrame(bytes) {
      if (!adapter) {
        // Frame-driven reconnect: the mic is live but the socket is not.
        if (micOpen) connect();
        log.debug("stt.frame-dropped", { sessionId, byteSize: bytes.byteLength, reason: "no live STT socket" });
        return;
      }
      adapter.send(bytes);
    },

    suppressInputFor(ms) {
      adapter?.suppressInputFor(ms);
    },

    close() {
      if (closed) return;
      closed = true;
      micOpen = false;
      log.info("stt.close", { sessionId, wasConnected: adapter !== null });
      lifetime.abort();
      const active = adapter;
      adapter = null;
      if (active) detach("close", () => active.close());
    },
  };
}
