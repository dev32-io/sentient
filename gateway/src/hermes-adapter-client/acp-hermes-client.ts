import type { HermesClient } from "../cerebrum/hermes-client.js";
import type { DispatchMode, HermesEvent, HermesTurnInput } from "../cerebrum/hermes-event-types.js";
import { getLog } from "../logging/logger.js";
import type { ActivitySource } from "../session/activity/activity-clock.js";
import type { InternalEvent } from "./event-translator.js";
import type { AcpPerProfileConnection } from "./per-profile-connection.js";

const log = getLog(["sentient", "hermes-adapter-client", "acp-hermes-client"]);

// ---------------------------------------------------------------------------
// AcpHermesClient — adapter facade.
//
// Translates the gateway-internal `HermesClient.dispatch` contract onto the
// ACP wire so the existing cerebrum dispatcher (`dispatchHermesCycle` +
// `translateHermesStream`) can drive a cycle without knowing which transport
// is underneath.
//
// Why this shape:
//   - The cerebrum is wired around an AsyncGenerator<HermesEvent>. Keeping
//     that signature lets the entire downstream pipeline (text-delta fork,
//     TTS, mirror updates, SDK frame emission) stay 100% unchanged across
//     the flag flip.
//   - ACP exposes a different surface (one prompt request + a stream of
//     session/update notifications terminated by a JSON-RPC response). This
//     adapter funnels both into the HermesEvent stream.
//   - InternalEvent (per-update translation, T4.4) is the canonical
//     ACP-side shape; mapping InternalEvent → HermesEvent is mechanical and
//     loss-tolerant (status / source fields outside the union are dropped).
//
// One adapter instance per HermesClient.dispatch call (created via the
// factory below). The adapter holds a reference to the long-lived
// AcpPerProfileConnection so cycles can subscribe / unsubscribe per dispatch.
// ---------------------------------------------------------------------------

export interface AcpHermesClientDeps {
  /** Long-lived ACP connection bootstrapped per WS session. */
  readonly acpConn: AcpPerProfileConnection;
  /** Bound to this session's device activity clock. Touched on every ACP event
   *  in (session/update) and the prompt send out. Optional so existing
   *  callers/tests without a clock still compile. */
  readonly onActivity?: (source: ActivitySource) => void;
}

interface QueueItem {
  readonly events: HermesEvent[];
  readonly done: boolean;
}

/** Tiny push/pull queue — sync push from listeners, awaited by the generator. */
class HermesEventQueue {
  private readonly buffer: QueueItem[] = [];
  private waiter: ((item: QueueItem) => void) | null = null;
  private finished = false;

  push(events: HermesEvent[], done: boolean): void {
    if (this.finished) return;
    if (done) this.finished = true;
    const item: QueueItem = { events, done };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
      return;
    }
    this.buffer.push(item);
  }

  async next(): Promise<QueueItem> {
    const head = this.buffer.shift();
    if (head !== undefined) return head;
    if (this.finished) return { events: [], done: true };
    return new Promise<QueueItem>((resolve) => {
      this.waiter = resolve;
    });
  }

  finish(): void {
    if (this.finished) return;
    this.push([], true);
  }
}

export function createAcpHermesClient(deps: AcpHermesClientDeps): HermesClient {
  return {
    async *dispatch(input: HermesTurnInput, signal: AbortSignal, _mode: DispatchMode): AsyncGenerator<HermesEvent> {
      const startedAtMs = Date.now();
      const queue = new HermesEventQueue();

      // Subscribe BEFORE any wire I/O so we never miss session/update
      // notifications (the eager `session.new` handler on the WS layer is
      // the primary path, but the lazy fallback below also issues a
      // `session/new` request — events for the resulting sessionId can
      // arrive immediately, even before sendUserMessage's send completes).
      const unsubEvents = deps.acpConn.onEvent((evt) => {
        deps.onActivity?.("acp.in");
        const translated = internalToHermesEvents(evt);
        if (translated.length === 0) return;
        queue.push(translated, false);
      });

      const unsubCycleDone = deps.acpConn.onCycleDone((evt) => {
        log.debug("dispatch.cycle-done", {
          cycleId: input.cycleId,
          acpCycleId: evt.cycleId,
          stopReason: evt.stopReason,
        });
        // Map to the cerebrum's terminal `completed` event. ACP does not
        // surface token usage in the prompt response shape we validate, so
        // emit zeros — the cerebrum's hermes-event-translator only logs
        // those values, never gates on them.
        queue.push([{ type: "completed", usage: { inputTokens: 0, outputTokens: 0 } }], true);
      });

      const onAbort = (): void => {
        log.info("dispatch.abort", { userId: input.userId, cycleId: input.cycleId });
        // Fire-and-forget — the cancelInflight notification is async but the
        // abort path doesn't need to wait. Hermes will resolve the in-flight
        // prompt with stopReason="cancelled" and our cycleDone listener
        // will close the queue then.
        deps.acpConn.cancelInflight().catch((err: unknown) => {
          log.warn("dispatch.cancel-failed", {
            cycleId: input.cycleId,
            reason: err instanceof Error ? err.message : String(err),
          });
        });
        queue.finish();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Resolve the ACP sessionId BEFORE building the prompt — three sources,
      // checked in priority order:
      //
      //   1. forcedSessionId — set by sessions-handlers.ts on session.new /
      //      session.switch. Already created server-side (eager path); we
      //      trust the caller's id verbatim.
      //   2. binding.conversationId — captured from a prior cycle's
      //      synthetic `created` event. Same chain continues.
      //   3. lazy session/new — ACP requires an explicit `session/new` before
      //      any `session/prompt`. The legacy custom-WS contract created
      //      sessions implicitly on first user.message; ACP does not. If the
      //      WS handler missed the eager path (sessions-handlers.ts not
      //      wired with acpConn, or first message arrived from a non-UI
      //      channel like an adapter sensor), THIS branch keeps the cycle
      //      from 404'ing on the server-side ACP `session not found`.
      //
      // The synthetic `created` event then carries whichever id won, so the
      // cerebrum's hermes-event-translator routes it to
      // sessionRouter.updateConversationId — meaning subsequent turns reuse
      // it via path (2) without re-minting.
      let resolvedSessionId: string;
      try {
        resolvedSessionId = await resolveAcpSessionId(deps.acpConn, input);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("dispatch.session-new-failed", {
          userId: input.userId,
          cycleId: input.cycleId,
          reason: message,
        });
        try {
          yield { type: "error", message };
        } finally {
          signal.removeEventListener("abort", onAbort);
          unsubEvents();
          unsubCycleDone();
        }
        return;
      }

      queue.push([{ type: "created", responseId: input.cycleId, conversationId: resolvedSessionId }], false);

      // Read back the REAL session id from the first session/update. If Hermes
      // forked (committed under a different id than we forced), emit a SECOND
      // ("corrective") `created` carrying the real id so the cerebrum re-anchors
      // onto Hermes' truth + log a warning so the fork is DETECTABLE. The
      // provisional created above stays (contract 1) — the FSM ungate and the
      // happy-path tests depend on it. Only the first update is acted on.
      let realSessionCaptured = false;
      const unsubSessionId = deps.acpConn.onSessionId((realId) => {
        if (realSessionCaptured) return;
        realSessionCaptured = true;
        if (realId !== resolvedSessionId) {
          log.warn("created.real-id-divergence", {
            userId: input.userId,
            cycleId: input.cycleId,
            forcedSessionId: resolvedSessionId,
            realSessionId: realId,
          });
          queue.push([{ type: "created", responseId: input.cycleId, conversationId: realId }], false);
        } else {
          log.debug("created.real-id-confirmed", { cycleId: input.cycleId, sessionId: realId });
        }
      });

      const promptArgs: { sessionId: string; text: string; internal?: boolean } = {
        sessionId: resolvedSessionId,
        text: input.userMessage,
      };
      log.info("dispatch.send", {
        userId: input.userId,
        cycleId: input.cycleId,
        sessionId: promptArgs.sessionId,
        forced: input.forcedSessionId !== undefined,
        chars: input.userMessage.length,
      });
      deps.onActivity?.("acp.out");
      const sendPromise = deps.acpConn.sendUserMessage(promptArgs);
      sendPromise.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("dispatch.send-failed", { userId: input.userId, cycleId: input.cycleId, reason: message });
        queue.push([{ type: "error", message }], true);
      });

      try {
        let eventCount = 0;
        while (true) {
          const item = await queue.next();
          for (const ev of item.events) {
            eventCount++;
            yield ev;
          }
          if (item.done) break;
        }
        log.info("dispatch.end", {
          userId: input.userId,
          cycleId: input.cycleId,
          eventCount,
          elapsedMs: Date.now() - startedAtMs,
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubEvents();
        unsubCycleDone();
        unsubSessionId();
      }
    },
  };
}

/**
 * Resolve which sessionId the ACP `session/prompt` should target. Forced and
 * captured ids fast-path; absence triggers a lazy `session/new` so the prompt
 * lands on a server-known session.
 */
async function resolveAcpSessionId(acpConn: AcpPerProfileConnection, input: HermesTurnInput): Promise<string> {
  if (input.forcedSessionId !== undefined) return input.forcedSessionId;
  if (input.conversationId !== null && input.conversationId !== undefined) return input.conversationId;
  log.info("dispatch.session-new.lazy", { userId: input.userId, cycleId: input.cycleId });
  const result = await acpConn.newSession({});
  log.info("dispatch.session-new.minted", {
    userId: input.userId,
    cycleId: input.cycleId,
    sessionId: result.sessionId,
  });
  return result.sessionId;
}

/**
 * Map an InternalEvent (ACP session/update translation) onto 0..N HermesEvents
 * the cerebrum stream expects. Events outside the cerebrum union (e.g. the
 * SDK-only `sessions.renamed`, `commands.available`) are dropped here — those
 * are emitted on a separate, non-cycle channel (T4.4 / T4.7 SDK fan-out).
 */
function internalToHermesEvents(evt: InternalEvent): HermesEvent[] {
  switch (evt.type) {
    case "assistant.message":
      // ACP delivers each assistant micro-turn as a complete text block;
      // append a trailing newline to match the legacy translator's segment
      // boundary contract (TTS aggregator + webui paragraph split).
      return [{ type: "text.delta", delta: `${evt.text}\n` }];
    case "tool.started":
      return [
        {
          type: "tool.started",
          callId: evt.callId,
          toolName: evt.toolName,
          argsPreview: evt.argsPreview,
        },
      ];
    case "tool.progress":
      // The cerebrum HermesEvent union has no progress slot today (the
      // legacy custom-WS translator also drops tool.progress). Forward-compat
      // only — log so operators can correlate timing.
      log.debug("internal-to-hermes.tool-progress.dropped", { callId: evt.callId });
      return [];
    case "tool.finished":
      return [
        {
          type: "tool.finished",
          callId: evt.callId,
          status: evt.status === "ok" ? "ok" : "failed",
          summary: evt.summary,
        },
      ];
    case "sessions.renamed":
    case "commands.available":
      // Out-of-band SDK frames — handled on a separate fan-out wire path,
      // never inside the cycle event stream.
      return [];
  }
}
