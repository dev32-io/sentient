// SessionRuntime (spec §4.5, Plan 2 Task 7) — the per-session owner that
// enforces one-turn-at-a-time serialization, implements "steer", owns the
// store handle + the current turn's AbortController, and turns stimuli into
// ReAct turns.
//
// The store IS the queue: every stimulus appends to the append-only store;
// this runtime tracks `lastProcessedSeq`, a high-water mark, and nothing
// else — no separate queue structure. This is the deleted AttentionGate's
// turn-backpressure MINUS salience, debounce, and thresholds.
//
// At most ONE turn (react-loop.ts's `runTurn`) runs at a time. `submit`:
//   - always appends the stimulus first — conversational → `user` entry,
//     background-completion → `trigger` entry (never `system`: react-loop.ts
//     appends `system` "task started" notes as ITS OWN self-output while a
//     turn runs, and never `user`/`trigger` — see TURN_TRIGGER_KINDS below.
//     Using `trigger` for external background-completion stimuli keeps that
//     self-output structurally unable to collide with an external trigger).
//   - if a turn is already running (`inFlight !== null`): returns after the
//     append. The running loop re-reads the store at the top of its next
//     iteration (react-loop.ts) and picks the new entry up for free — that
//     re-read IS the steer mechanism; this runtime adds no extra signalling.
//   - if idle: starts a turn. `lastProcessedSeq` is snapshotted to the
//     store's current max seq immediately before `runTurn` is invoked (both
//     synchronous, no intervening await, so the snapshot is guaranteed to be
//     ≤ whatever the turn's first iteration reads). When the turn ends, if
//     the store grew past that snapshot with a `user`/`trigger` entry, a
//     back-to-back next turn starts immediately (re-snapshotting before it
//     runs). This intentionally does not try to distinguish "was this
//     specific append absorbed by a later iteration of the turn that just
//     ended" from "did it arrive too late for any iteration to see it" —
//     that requires instrumenting the loop's internal iteration boundaries,
//     which the brief explicitly says to skip. The simplification always
//     errs toward firing an extra (occasionally redundant, cheap, harmless)
//     back-to-back turn rather than ever silently stranding a stimulus the
//     model never saw — a stranded stimulus is still safe here (it remains
//     in the store and rides along on the NEXT turn's full-history read
//     regardless of what triggers that turn), but firing promptly matches
//     the system's job of always following up on what was said.
//
// Self-output (assistant/tool_call/tool_result/system entries the loop
// itself appends) must NOT re-trigger a turn. `TURN_TRIGGER_KINDS` is
// exactly `{user, trigger}` — the two kinds that are, by construction,
// NEVER appended by react-loop.ts itself (confirmed against every
// `store.append` call site in react-loop.ts: tool_call, system, tool_result,
// assistant — never user or trigger).
//
// Re-entrancy: because Bun is single-threaded and there is no `await`
// between the "is a turn running" check (`inFlight !== null`) and setting
// the in-flight marker (`inFlight = {...}`), that check-and-set is atomic —
// no interleaved `submit` can observe a window where two turns look
// startable. The same holds for the back-to-back restart inside
// `onTurnSettled`: clearing `inFlight` and deciding whether to start the
// next turn happen in one synchronous continuation.

import type { OrchestratorConfig } from "@sentient/config";
import type { TurnTrigger } from "@sentient/protocol";
import type { AccessManager } from "../access/access-manager.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { ProviderClient } from "../provider/provider-client.js";
import type { NewSessionEntry, SessionEntry } from "../store/entry-types.js";
import { openSessionStore } from "../store/session-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { UserId } from "../user-auth/user-id.js";
import type { CancellableTurn } from "./cancellation.js";
import { createCancellationControllers } from "./cancellation.js";
import type { ReactLoopDeps } from "./react-loop.js";
import { runTurn } from "./react-loop.js";
import type { Stimulus } from "./stimulus.js";
import type { TurnEmitter } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "session-runtime"]);

/** Entry kinds that count as a turn trigger — conversational input and
 *  background-completion notes. Deliberately excludes assistant / tool_call
 *  / tool_result / system / compaction: those are always the loop's OWN
 *  output (self-output must never re-trigger a turn). */
const TURN_TRIGGER_KINDS = new Set<SessionEntry["kind"]>(["user", "trigger"]);

export interface SessionRuntime {
  readonly userId: UserId;
  /** Conversational text or a background-task completion. Appends to the
   *  store; steers the running turn if one is in flight, otherwise starts
   *  one. Never throws — a `submit` after `dispose()` is a logged no-op. */
  submit(stimulus: Stimulus): void;
  /** True the instant a turn is in flight (set synchronously by `submit`,
   *  cleared synchronously when that turn's `runTurn` promise settles). */
  readonly running: boolean;
  /** Aborts any in-flight turn's signal, stops the store handle, and makes
   *  every subsequent `submit` a no-op. Idempotent. */
  dispose(): void;
  /** Mic onset — the user starts speaking over the assistant (spec §4.7).
   *  Aborts the in-flight turn (+ TTS, Plan 3) and commits its partial
   *  output as an assistant entry with `cutoff: "barge-in"`, but LEAVES any
   *  registered background task running. No-op if idle. See
   *  `runtime/cancellation.ts`. */
  bargeIn(): void;
  /** UI Stop / Esc (spec §4.7). Aborts the in-flight turn (+ TTS, Plan 3),
   *  commits its partial output as an assistant entry with
   *  `cutoff: "interrupt"`, AND cancels every background task for this
   *  session (`broker.background.cancelAll()`) — fires even if no turn is
   *  in flight, since a background task outlives the turn that dispatched
   *  it. See `runtime/cancellation.ts`. */
  interrupt(): void;
}

export interface SessionRuntimeDeps {
  principal: UserPrincipal;
  sessionId: string;
  accessManager: AccessManager;
  provider: ProviderClient;
  broker: ToolBroker;
  emitter: TurnEmitter;
  systemPrompt: string;
  config: OrchestratorConfig;
}

interface InFlightTurn {
  turnId: string;
  controller: AbortController;
  /** Set synchronously (via `onTurnCommitting`) the instant react-loop.ts
   *  appends this turn's terminal assistant entry — i.e. the turn reached a
   *  natural completion and its final text is already durable in the store,
   *  even though `inFlight` itself isn't cleared until the async
   *  `onTurnSettled` continuation runs. Closes the terminal-completion race:
   *  a bargeIn()/interrupt() landing in that window must treat the turn as
   *  already settled (see cancellation.ts's `abortTurn`), never re-commit
   *  its text or fire a spurious `turnAborted`. */
  settled: boolean;
}

function blankEntry(sessionId: string, turnId: string): Omit<NewSessionEntry, "kind"> {
  return {
    sessionId,
    turnId,
    createdAt: Date.now(),
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
  };
}

function stimulusEntryKind(stimulus: Stimulus): "user" | "trigger" {
  return stimulus.kind === "conversational" ? "user" : "trigger";
}

function stimulusTrigger(stimulus: Stimulus): TurnTrigger {
  return stimulus.kind === "conversational" ? "user" : "background-completion";
}

function stimulusText(stimulus: Stimulus): string {
  return stimulus.kind === "conversational" ? stimulus.text : stimulus.note;
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
  const { principal, sessionId, accessManager, provider, broker, emitter, systemPrompt, config } = deps;
  const userId = principal.userId;

  const cap = accessManager.grant(principal, "session-store");
  const store: SessionStore = openSessionStore(cap);

  let inFlight: InFlightTurn | null = null;
  let lastProcessedSeq = 0;
  let disposed = false;
  // Text streamed so far for the CURRENT, not-yet-committed loop iteration —
  // reset to "" the instant the loop itself commits that text durably.
  // Two commit points, two reset hooks: `onToolUpdate` firing is a reliable
  // proxy for "narration, if any, is already durable" because react-loop.ts
  // always appends narration BEFORE the first `onToolUpdate` call of an
  // iteration (see react-loop.ts's `dispatchToolCalls`); `onTurnCommitting`
  // fires the instant the loop appends the terminal assistant entry on
  // natural completion (no-toolcalls / forced-final) — the fix for the
  // terminal-completion race (Task 8 follow-up): without this second hook,
  // a bargeIn()/interrupt() landing after the terminal commit but before
  // `inFlight` is asynchronously cleared would still see the already-
  // committed text sitting in this accumulator and double-append it as a
  // bogus cutoff entry. Read by cancellation.ts via `getInFlight()` below —
  // never resurrected once a turn ends, `startTurn` resets it fresh for
  // every new turn.
  let turnText = "";

  const cancellation = createCancellationControllers({
    sessionId,
    userId,
    store,
    broker,
    emitter,
    getInFlight: (): CancellableTurn | null =>
      inFlight
        ? { turnId: inFlight.turnId, controller: inFlight.controller, text: turnText, settled: inFlight.settled }
        : null,
  });

  function currentMaxSeq(): number {
    const entries = store.readSession(sessionId);
    const last = entries[entries.length - 1];
    return last ? last.seq : 0;
  }

  /** The trigger for the next back-to-back turn (spec §4.5), or null when
   *  nothing is pending. Same unprocessed-stimulus window the old
   *  `hasUnprocessedStimuli` read; a pending `user` entry outranks a
   *  `trigger` (background-completion) entry, because a person waiting on a
   *  reply is what the client should label the new bubble with. */
  function nextTurnTrigger(): TurnTrigger | null {
    const pending = store.readSince(sessionId, lastProcessedSeq).filter((e) => TURN_TRIGGER_KINDS.has(e.kind));
    if (pending.length === 0) return null;
    return pending.some((e) => e.kind === "user") ? "user" : "background-completion";
  }

  function appendStimulus(stimulus: Stimulus, turnId: string): SessionEntry {
    return store.append({
      ...blankEntry(sessionId, turnId),
      kind: stimulusEntryKind(stimulus),
      text: stimulusText(stimulus),
    });
  }

  function onTurnSettled(turnId: string, result: { completed: boolean; iterations: number }): void {
    inFlight = null;
    log.info("session-runtime.turn.end", {
      userId,
      sessionId,
      turnId,
      completed: result.completed,
      iterations: result.iterations,
    });

    if (result.completed) {
      emitter.turnCompleted(turnId);
    } else {
      // Cutoff-kind stamping (interrupt|barge-in) on the partial output is
      // Task 8's job (spec §4.7) — this runtime only owns starting/clearing
      // the AbortController the abort came through.
      log.warn("session-runtime.turn.not-completed", { userId, sessionId, turnId, iterations: result.iterations });
    }

    if (disposed) {
      log.debug("session-runtime.turn.settled-after-dispose", { userId, sessionId, turnId });
      return;
    }

    const trigger = nextTurnTrigger();
    if (trigger !== null) {
      const nextTurnId = crypto.randomUUID();
      log.info("session-runtime.turn.next-turn-trigger", {
        userId,
        sessionId,
        previousTurnId: turnId,
        nextTurnId,
        trigger,
      });
      startTurn(nextTurnId, trigger);
    }
  }

  function startTurn(turnId: string, trigger: TurnTrigger): void {
    // Re-entrancy guard: a future TurnEmitter.turnCompleted callback could call
    // submit() synchronously from inside onTurnSettled's clear-and-decide window;
    // without this, that re-entrant start plus onTurnSettled's own next-turn start
    // would overwrite a live `inFlight` and run two concurrent turns over one
    // store — the exact torn-feed invariant this runtime protects. No-op if a
    // turn is already in flight; the caller has already appended its stimulus,
    // so the running (or about-to-run) turn absorbs it via steer.
    if (inFlight !== null) return;
    const controller = new AbortController();
    inFlight = { turnId, controller, settled: false };
    // Synchronous snapshot, no await between this and the `runTurn` call
    // below — guarantees the turn's first iteration sees everything ≤ this.
    lastProcessedSeq = currentMaxSeq();
    turnText = ""; // fresh accumulator for this turn — see the field's doc comment above.

    emitter.turnStarted(turnId, trigger);
    log.info("session-runtime.turn.start", { userId, sessionId, turnId, trigger, lastProcessedSeq });

    const loopDeps: ReactLoopDeps = {
      provider,
      broker,
      store,
      systemPrompt,
      sessionId,
      config: config.loop,
      onTextDelta: (id, text) => {
        turnText += text;
        emitter.textDelta(id, text);
      },
      onToolUpdate: (id, u) => {
        // Any onToolUpdate call is preceded by the loop committing this
        // iteration's narration (if it had any) to the store directly — see
        // react-loop.ts's `dispatchToolCalls`. That text is durable now, so
        // drop it from the cutoff accumulator; the next iteration's deltas
        // (if any) start counting fresh.
        turnText = "";
        emitter.toolUpdate(id, u);
      },
      onTurnCommitting: (id) => {
        // Fires synchronously right after react-loop.ts appends the terminal
        // assistant entry for a natural completion — BEFORE `runTurn`'s
        // promise resolves and long before the async `onTurnSettled`
        // continuation clears `inFlight`. Closes the terminal-completion
        // race (Task 8 follow-up): a bargeIn()/interrupt() landing in that
        // window must neither re-commit this already-durable text nor fire a
        // spurious turnAborted for a turn that already completed normally.
        turnText = ""; // text is durable now — commitCutoffEntry's empty-text guard no-ops.
        if (inFlight && inFlight.turnId === id) {
          inFlight.settled = true;
        }
      },
    };

    runTurn(loopDeps, { turnId, signal: controller.signal }).then(
      (result) => onTurnSettled(turnId, result),
      (err: unknown) => {
        // react-loop.ts's contract is "never throw" — this is a defensive
        // backstop only, so a bug elsewhere can never wedge the one-turn
        // guard open forever.
        log.error("session-runtime.turn.threw", {
          userId,
          sessionId,
          turnId,
          reason: err instanceof Error ? err.message : String(err),
        });
        onTurnSettled(turnId, { completed: false, iterations: 0 });
      },
    );
  }

  function submit(stimulus: Stimulus): void {
    if (disposed) {
      log.warn("session-runtime.submit.disposed", { userId, sessionId, kind: stimulus.kind });
      return;
    }

    if (inFlight) {
      const entry = appendStimulus(stimulus, inFlight.turnId);
      log.info("session-runtime.submit.steer", {
        userId,
        sessionId,
        kind: stimulus.kind,
        seq: entry.seq,
        turnId: inFlight.turnId,
      });
      return;
    }

    const turnId = crypto.randomUUID();
    const entry = appendStimulus(stimulus, turnId);
    log.info("session-runtime.submit.start-turn", { userId, sessionId, kind: stimulus.kind, seq: entry.seq, turnId });
    startTurn(turnId, stimulusTrigger(stimulus));
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    log.info("session-runtime.dispose", { userId, sessionId, hadInFlight: inFlight !== null });
    inFlight?.controller.abort();
    store.close();
  }

  return {
    userId,
    submit,
    get running() {
      return inFlight !== null;
    },
    dispose,
    bargeIn: cancellation.bargeIn,
    interrupt: cancellation.interrupt,
  };
}
