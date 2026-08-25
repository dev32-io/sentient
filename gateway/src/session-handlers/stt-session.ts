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
  start(captureId: string, turnMode: TurnMode): boolean;
  /** Matching client `audio.end` — force-finalize and commit manual text. */
  end(captureId: string): void;
  /** Matching client `audio.cancel` — discard without a flush or submission. */
  cancel(captureId: string): void;
  /** One inbound binary WS frame for the named open capture. */
  pushFrame(captureId: string, bytes: Uint8Array): void;
  /** Echo-suppression window (ms). `0` clears it. See mic-echo-guard.ts. */
  suppressInputFor(ms: number): void;
  /**
   * Bytes forwarded to STT since the current utterance began — reset by
   * `start`, `end` and `discard`.
   *
   * It is the OBSERVABLE that makes "the buffer was dropped, not flushed"
   * checkable from outside. Approximate by construction: the authoritative
   * buffer lives in the STT service, and this counts what was handed to it.
   */
  readonly buffered: number;
  /**
   * Drop the in-flight utterance WITHOUT finalizing it (task 9, spec §3.7).
   *
   * The distinction from `end()` is the whole reason this exists: `end()`
   * force-flushes, so whatever half-sentence is open would be transcribed and
   * submitted — into whichever session this connection is on NOW. Committing
   * half an utterance into the wrong conversation is worse than dropping it.
   *
   * Implemented by closing the STT socket, which is the only primitive the
   * adapter contract offers that abandons an open turn rather than completing
   * it. The capture is terminal: the client must send a fresh `audio.start`
   * before any subsequent frame can be accepted.
   */
  discard(): void;
  /** Connection teardown — idempotent. */
  close(): void;
}

export interface SttSessionDeps {
  readonly sessionId: string;
  readonly factory: STTAdapterFactory;
  readonly config: STTAdapterConfig;
  /** Read fresh on every event: `session.configure` can re-mint the runtime.
   *  NEVER mints a session — a mic onset with nothing running has nothing to
   *  barge into, and a draft must not become a session because someone
   *  breathed near the microphone. */
  readonly getRuntime: () => SessionRuntime | null;
  /** The runtime a TRANSCRIPT goes to. Distinct from `getRuntime` because a
   *  voice-first draft has no session yet: spoken words are a first message
   *  like any other, and this is the seam that mints one (spec §4.2).
   *
   *  ASYNC because minting one goes through `bindSessionRuntime`, which
   *  re-resolves this connection's authority against the user record before it
   *  turns a principal into a capability (session-binding.ts). `dispatch`
   *  awaits it in the event loop, so transcripts still submit strictly in
   *  order. */
  readonly getRuntimeForInput: (text: string) => Promise<SessionRuntime | null>;
}

export function createSttSession(deps: SttSessionDeps): SttSession {
  const { sessionId, factory, config, getRuntime, getRuntimeForInput } = deps;
  const lifetime = new AbortController();

  let adapter: STTAdapter | null = null;
  let connecting = false;
  let closed = false;
  let micOpen = false;
  let desiredTurnMode: TurnMode = INITIAL_TURN_MODE;
  let bufferedBytes = 0;
  interface CaptureContext {
    readonly id: string;
    readonly mode: TurnMode;
    readonly epoch: number;
    status: "active" | "committing";
    transcripts: string[];
    submitted: boolean;
  }
  let capture: CaptureContext | null = null;
  // Bumped by `discard()`. A connect started before the discard must not
  // install its adapter afterwards — that would resurrect the very socket the
  // discard abandoned, complete with the open turn it was abandoning.
  let uplinkEpoch = 0;

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

  /** [active] is the adapter this event was read from — carried in so the
   *  post-await re-check below can ask the SAME question the loop asks before
   *  dispatching, rather than a second one that could drift from it. */
  async function dispatch(event: STTEvent, active: STTAdapter, eventCapture: CaptureContext): Promise<void> {
    if (event.type === "turn_dropped") {
      log.debug("stt.turn-dropped", { sessionId, captureId: eventCapture.id, turnIdx: event.turnIdx });
      if (eventCapture.status === "committing" && capture === eventCapture) capture = null;
      return;
    }
    if (event.type === "turn_started") {
      // Barge-in (spec §4.7): fire on mic onset, BEFORE the transcript lands,
      // so the assistant stops talking as early as possible. Background tasks
      // keep running — that distinction lives in cancellation.ts.
      const running = getRuntime();
      if (!running) {
        log.debug("stt.barge-in.no-runtime", {
          sessionId,
          turnIdx: event.turnIdx,
          reason: "draft or unconfigured orchestrator — nothing is speaking",
        });
        return;
      }
      log.info("stt.barge-in", { sessionId, turnIdx: event.turnIdx });
      running.bargeIn();
      return;
    }
    const text = event.text.trim();
    if (text.length === 0) {
      log.debug("stt.transcript.blank", {
        sessionId,
        captureId: eventCapture.id,
        turnIdx: event.turnIdx,
        reason: "empty after trim",
      });
      if (eventCapture.status === "committing" && capture === eventCapture) capture = null;
      return;
    }
    if (eventCapture.mode === "manual") {
      eventCapture.transcripts.push(text);
      if (eventCapture.status !== "committing" || eventCapture.submitted) return;
    }
    const submittedText = eventCapture.mode === "manual" ? eventCapture.transcripts.join(" ") : text;
    const runtime = await getRuntimeForInput(submittedText);
    // RE-CHECKED AFTER THE AWAIT, and this is the second half of the guard the
    // loop below performs before dispatching — not a duplicate of it.
    //
    // `getRuntimeForInput` is genuinely async: on a voice-first draft it MINTS
    // the session (a SQLite write) and then re-resolves this connection's
    // authority against the user record (`bindSessionRuntime`), so the window
    // between the loop's check and this line spans real I/O. A
    // `conversation.activate` landing inside it runs `discard()`, which clears
    // `adapter` — and without this line the resumed dispatch would submit words
    // captured in the session the user just LEFT into the one they switched to,
    // or into a runtime the registry has since disposed. That is precisely the
    // hazard `discard()` exists to prevent, arriving through the back door the
    // await opened.
    //
    // `close()` nulls `adapter` too, so this covers a socket that went away
    // mid-mint by the same predicate.
    if (
      adapter !== active ||
      capture !== eventCapture ||
      eventCapture.epoch !== uplinkEpoch ||
      (eventCapture.mode === "manual" && eventCapture.submitted)
    ) {
      log.info("stt.transcript.after-discard", {
        sessionId,
        captureId: eventCapture.id,
        turnIdx: event.turnIdx,
        reason: "the uplink was discarded while this transcript was resolving a runtime — dropping it",
      });
      return;
    }
    if (!runtime) {
      log.warn("stt.event.no-runtime", {
        sessionId,
        eventType: event.type,
        reason: "orchestrator unconfigured, or the session could not be minted for this transcript",
      });
      return;
    }
    if (eventCapture.mode === "manual") eventCapture.submitted = true;
    log.info("stt.transcript.submit", {
      sessionId,
      captureId: eventCapture.id,
      mode: eventCapture.mode,
      turnIdx: event.turnIdx,
      length: submittedText.length,
    });
    runtime.submit({ kind: "conversational", text: submittedText });
    if (eventCapture.status === "committing" && capture === eventCapture) capture = null;
  }

  async function consumeEvents(active: STTAdapter): Promise<void> {
    try {
      for await (const event of active.events(lifetime.signal)) {
        // ABANDONED UPLINK — stop, do not dispatch. `discard()` clears
        // `adapter` synchronously but its `close()` only round-trips later, so
        // a socket that had already decoded an utterance keeps yielding it in
        // the meantime. Dispatching any of that would submit words captured in
        // the session this connection has LEFT into the one it is on now, or
        // barge into that session's turn — the exact hazard `discard()` exists
        // to prevent, arriving through the back door.
        if (adapter !== active) {
          log.info("stt.event.after-discard", {
            sessionId,
            eventType: event.type,
            reason: "this uplink was discarded — its events belong to a session this connection has left",
          });
          break;
        }
        // A hook throw must never kill the event loop for the rest of the
        // session — the pre-purge adapter learned this the hard way.
        const eventCapture = capture;
        if ((!micOpen && eventCapture?.status !== "committing") || eventCapture === null) {
          log.info("stt.event.capture-closed", {
            sessionId,
            eventType: event.type,
            reason: "no open or committing capture owns this adapter callback",
          });
          continue;
        }
        try {
          // AWAITED, so the next event cannot overtake this one: a transcript
          // that has to mint a session is slower than one that does not, and
          // two spoken turns arriving back-to-back must still submit in order.
          //
          // `active` goes with it: the check above is only good for the instant
          // it runs, and `dispatch` suspends. It re-asks the same question on
          // the other side of its await.
          await dispatch(event, active, eventCapture);
        } catch (err: unknown) {
          log.warn("stt.event.dispatch-failed", {
            sessionId,
            eventType: event.type,
            reason: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // An event delivered after End is the adapter's terminal response,
          // even when dispatching that response failed or found no runtime.
          // Never leave the capture in `committing`: it would reject every
          // later Start forever.
          if (eventCapture.status === "committing" && capture === eventCapture) {
            capture = null;
            micOpen = false;
            bufferedBytes = 0;
          }
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
        // Active semantic capture may recover on its next frame. Manual input
        // cannot be reconstructed across adapters, and any capture already
        // committing is terminal because its flush stream has ended.
        if (capture?.mode === "manual" || capture?.status === "committing") {
          log.info("stt.capture.discarded", {
            sessionId,
            captureId: capture.id,
            mode: capture.mode,
            bufferedBytes,
            transition: `${capture.status}->closed`,
            reason: "adapter event stream ended before commit completed",
          });
          capture = null;
          micOpen = false;
          bufferedBytes = 0;
        }
        log.info("stt.disconnected", { sessionId, micOpen, reason: "event stream ended" });
      }
    }
  }

  function connect(): void {
    if (closed || connecting || adapter !== null) return;
    connecting = true;
    const startedAtEpoch = uplinkEpoch;
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
        if (startedAtEpoch !== uplinkEpoch) {
          log.info("stt.connect-superseded", {
            sessionId,
            reason: "the uplink was discarded while this socket was connecting — closing it instead of installing it",
          });
          detach("close-after-discard", () => candidate.close());
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
    start(captureId, turnMode) {
      // A committed capture remains here only while its final adapter callback
      // is outstanding. Refusing overlap is safer than attributing that callback
      // to a newer identity (or dropping a Send by rotating the socket).
      if (closed || capture !== null) return false;
      micOpen = true;
      desiredTurnMode = turnMode;
      bufferedBytes = 0;
      capture = {
        id: captureId,
        mode: turnMode,
        epoch: uplinkEpoch,
        status: "active",
        transcripts: [],
        submitted: false,
      };
      log.info("stt.audio-start", {
        sessionId,
        captureId,
        mode: turnMode,
        bufferedBytes,
        transition: "closed->active",
        connected: adapter !== null,
      });
      if (adapter) {
        adapter.setTurnMode(turnMode);
        return true;
      }
      connect();
      return true;
    },

    end(captureId) {
      const current = capture;
      if (current === null || current.id !== captureId || current.status !== "active") return;
      micOpen = false;
      current.status = "committing";
      log.info("stt.audio-end", {
        sessionId,
        captureId,
        mode: current.mode,
        connected: adapter !== null,
        bufferedBytes,
        transition: "active->committing",
      });
      bufferedBytes = 0;
      try {
        adapter?.endUtterance();
      } catch (err: unknown) {
        log.warn("stt.audio-end.failed", {
          sessionId,
          captureId,
          mode: current.mode,
          reason: err instanceof Error ? err.message : String(err),
        });
        this.cancel(captureId);
        return;
      }
      if (!adapter) {
        log.info("stt.capture.discarded", {
          sessionId,
          captureId,
          mode: current.mode,
          bufferedBytes,
          transition: "committing->closed",
          reason: "no adapter was available to flush",
        });
        capture = null;
        return;
      }
      // A manual adapter may have finalized just before the control arrived.
      // It was buffered rather than submitted; a successful flush now opens
      // the commit gate for that sanitized value.
      if (current.mode === "manual" && current.transcripts.length > 0 && !current.submitted) {
        const active = adapter;
        const text = current.transcripts.join(" ");
        detach("submit-manual", async () => {
          try {
            const runtime = await getRuntimeForInput(text);
            if (
              adapter !== active ||
              capture !== current ||
              current.epoch !== uplinkEpoch ||
              current.submitted ||
              !runtime
            )
              return;
            current.submitted = true;
            log.info("stt.transcript.submit", {
              sessionId,
              captureId,
              mode: current.mode,
              turnIdx: null,
              length: text.length,
            });
            runtime.submit({ kind: "conversational", text });
          } finally {
            // Runtime lookup/submission failure is still a terminal outcome for
            // the committed capture; otherwise no later capture can start.
            if (capture === current) capture = null;
          }
        });
      }
    },

    cancel(captureId) {
      if (capture?.id !== captureId) return;
      uplinkEpoch += 1;
      const current = capture;
      const active = adapter;
      capture = null;
      adapter = null;
      micOpen = false;
      log.info("stt.audio-cancel", {
        sessionId,
        captureId,
        mode: current.mode,
        bufferedBytes,
        transition: `${current.status}->closed`,
        reason: "matching cancel won the terminal race — dropping without flush",
      });
      bufferedBytes = 0;
      if (active) detach("cancel", () => active.close());
    },

    pushFrame(captureId, bytes) {
      if (capture?.id !== captureId || capture.status !== "active" || !micOpen) {
        log.debug("stt.frame-dropped", {
          sessionId,
          captureId,
          byteSize: bytes.byteLength,
          reason: "capture is not open",
        });
        return;
      }
      if (!adapter) {
        connect();
        log.debug("stt.frame-dropped", {
          sessionId,
          captureId,
          byteSize: bytes.byteLength,
          reason: "no live STT socket",
        });
        return;
      }
      bufferedBytes += bytes.byteLength;
      adapter.send(bytes);
    },

    suppressInputFor(ms) {
      adapter?.suppressInputFor(ms);
    },

    get buffered() {
      return bufferedBytes;
    },

    discard() {
      if (closed) return;
      uplinkEpoch += 1;
      const active = adapter;
      const discarded = capture;
      adapter = null;
      capture = null;
      micOpen = false;
      log.info("stt.discard", {
        sessionId,
        captureId: discarded?.id ?? null,
        mode: discarded?.mode ?? null,
        wasConnected: active !== null,
        bufferedBytes,
        transition: `${discarded?.status ?? "closed"}->closed`,
        reason: "connection capture was discarded without a flush",
      });
      bufferedBytes = 0;
      if (active) detach("discard", () => active.close());
    },

    close() {
      if (closed) return;
      closed = true;
      micOpen = false;
      const closingCapture = capture;
      capture = null;
      log.info("stt.close", {
        sessionId,
        captureId: closingCapture?.id ?? null,
        mode: closingCapture?.mode ?? null,
        bufferedBytes,
        transition: `${closingCapture?.status ?? "closed"}->closed`,
        wasConnected: adapter !== null,
      });
      bufferedBytes = 0;
      lifetime.abort();
      const active = adapter;
      adapter = null;
      if (active) detach("close", () => active.close());
    },
  };
}
