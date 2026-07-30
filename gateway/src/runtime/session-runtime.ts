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
//
// The COMMITTED FEED (spec §3.2) hangs off the same store. This runtime is
// the only thing that knows when an append became durable, so it is also the
// only thing that can publish it: `conversation-feed.ts` is driven from four
// points here — the stimulus append in `submit`, the loop's `onToolUpdate`
// durability signal, the turn boundary in `onTurnSettled`, and the cutoff
// commit in `cancellation.ts`. Everything on the `turn.*` wire family is a
// live stream the client discards on `turn.completed`; without these frames
// the reply visibly vanishes and the user's own message never renders.
//
// Compaction (spec §8/§3.4) hangs off the settle path, not the loop: the
// marker is appended after the turn's terminal frame and before `inFlight`
// clears. That ordering is required, not stylistic — model-projection.ts
// slices positionally from the latest marker, so a marker is only truthful
// when the store's tail IS its boundary, which is only true between turns.
// See runtime/compaction.ts's header.
//
// DISPOSED IS A TERMINAL STATE, AND IT IS LOAD-BEARING FOR THE PROCESS.
// `dispose()` closes the bun:sqlite handle synchronously, so every later touch
// of `store` — directly, or through `feed` / `cancellation` / `maybeCompact` —
// raises "Statement has finalized". Two of this runtime's seams outlive the
// dispose that closed the handle:
//
//   - the SETTLE CONTINUATION. `runTurn` is awaited on a DETACHED `.then`
//     chain, so a turn still in flight when the socket dies (a tab closed or
//     reloaded mid-reply, or the newer connection of a same-tab reload
//     evicting the superseded one — conversation-runtime-registry.ts) settles
//     AFTER `dispose()`. A throw there is an `unhandledRejection`, and Bun
//     answers one by exiting the process: the whole gateway, for every
//     connected user, because one tab reloaded.
//   - the PUBLIC GESTURES. `submit` (the background-completion sink holds this
//     runtime by reference), `bargeIn`, `interrupt`, `emitConversationSnapshot`.
//
// So every one of them is inert after `dispose()` — a WARN-logged no-op, not a
// caught throw. Nothing is swallowed by that: a GENUINE store failure on a
// live runtime still propagates to the one place a detached chain can be
// caught (`settle` below) and is logged with its reason.

import type { OrchestratorConfig } from "@sentient/config";
import type { TurnTrigger } from "@sentient/protocol";
import type { AccessManager } from "../access/access-manager.js";
import { loadCompactionSummarizerPrompt } from "../context/system-prompt-loader.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { ProviderClient } from "../provider/provider-client.js";
import type { CutoffKind, NewSessionEntry, SessionEntry } from "../store/entry-types.js";
import { openSessionStore } from "../store/session-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { UserId } from "../user-auth/user-id.js";
import type { CancellableTurn } from "./cancellation.js";
import { createCancellationControllers } from "./cancellation.js";
import { createCompactionGate, maybeCompact } from "./compaction.js";
import { createConversationFeed } from "./conversation-feed.js";
import type { ReactLoopDeps } from "./react-loop.js";
import { type TurnOutcome, runTurn } from "./react-loop.js";
import type { Stimulus } from "./stimulus.js";
import type { TurnEmitter } from "./turn-emitter.js";
import type { TurnVoice, TurnVoiceStream } from "./turn-voice.js";

const log = getLog(["sentient", "runtime", "session-runtime"]);

/** Entry kinds that count as a turn trigger — conversational input and
 *  background-completion notes. Deliberately excludes assistant / tool_call
 *  / tool_result / system / compaction: those are always the loop's OWN
 *  output (self-output must never re-trigger a turn). */
const TURN_TRIGGER_KINDS = new Set<SessionEntry["kind"]>(["user", "trigger"]);

// Resolved once at module load (operator override → baked-in template),
// matching system-prompt-loader.ts's DEFAULT_PERSONA precedent: a missing
// baked-in template is a boot-time failure, not a per-turn surprise.
const COMPACTION_SUMMARIZER_PROMPT = loadCompactionSummarizerPrompt();

export interface SessionRuntime {
  readonly userId: UserId;
  /** Conversational text or a background-task completion. Appends to the
   *  store; steers the running turn if one is in flight, otherwise starts
   *  one. Never throws — a `submit` after `dispose()` is a logged no-op. */
  submit(stimulus: Stimulus): void;
  /** True the instant a turn is in flight (set synchronously by `submit`,
   *  cleared synchronously when that turn's `runTurn` promise settles). */
  readonly running: boolean;
  /** Aborts any in-flight turn's signal, CUTS this session's still-draining
   *  speech (audio outlives its turn, and the next `session.configure` mints a
   *  fresh `TurnVoice` that could never reach it), closes the store handle, and
   *  makes EVERY subsequent method on this object a logged no-op — including
   *  the settle continuation of a turn that was still in flight. Idempotent. */
  dispose(): void;
  /** Mic onset — the user starts speaking over the assistant (spec §4.7).
   *  Aborts the in-flight turn and commits its partial output as an assistant
   *  entry with `cutoff: "barge-in"`, but LEAVES any registered background
   *  task running. Cuts this session's speech and flushes client playback
   *  even when no turn is in flight — audio outlives its turn. See
   *  `runtime/cancellation.ts`. A no-op after `dispose()`. */
  bargeIn(): void;
  /** UI Stop / Esc (spec §4.7). Aborts the in-flight turn, commits its
   *  partial output as an assistant entry with `cutoff: "interrupt"`, cuts
   *  speech + flushes client playback, AND cancels every background task for
   *  this session (`broker.background.cancelAll()`). The last two fire even
   *  with no turn in flight: a background task outlives the turn that
   *  dispatched it, and so does the audio. See `runtime/cancellation.ts`.
   *  A no-op after `dispose()`. */
  interrupt(): void;
  /** Publish this session's whole committed feed as `conversation.snapshot`
   *  and arm the live `conversation.entry` cursor at its tail. Called once
   *  per NON-recovered `session.configure` (ws-session-configure.ts) — a
   *  recovered resume replays the exact frames the client missed instead.
   *  A no-op after `dispose()`. */
  emitConversationSnapshot(): void;
}

export interface SessionRuntimeDeps {
  principal: UserPrincipal;
  /**
   * The DURABLE conversation id — this runtime's partition of the session
   * store (its `session_id` column), and the only thing this field is: every
   * read, append, projection and compaction below scopes to it.
   *
   * It is NOT `ws.data.sessionId`, which is minted per WebSocket connection
   * and dies with the socket. `handleSessionConfigure` resolves the durable
   * id (principal + the client's stable surface id) and passes THAT here —
   * keying the store on the connection id instead opened a brand-new empty
   * partition on every reload, reconnect and gateway restart. The field keeps
   * its name only because the store's own vocabulary for a partition is
   * `sessionId`.
   */
  sessionId: string;
  accessManager: AccessManager;
  provider: ProviderClient;
  broker: ToolBroker;
  emitter: TurnEmitter;
  systemPrompt: string;
  config: OrchestratorConfig;
  /**
   * This session's TTS fork (spec §6). Built at the WS layer and handed in
   * so the turn's OWN AbortController drives it — see turn-voice.ts's header
   * for why a TTS controller minted anywhere else would survive barge-in.
   * Null/absent for text-only sessions (no `tts:` config, headless harness).
   */
  voice?: TurnVoice | null;
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
  /** This turn's TTS text sink, or null when the session is text-only. */
  speech: TurnVoiceStream | null;
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
  const voice = deps.voice ?? null;
  const userId = principal.userId;

  const cap = accessManager.grant(principal, "session-store");
  const store: SessionStore = openSessionStore(cap);

  const feed = createConversationFeed({ store, sessionId, userId, emitter });

  let inFlight: InFlightTurn | null = null;
  let lastProcessedSeq = 0;
  // Per-session: a summarizer that keeps failing must not burn one provider
  // call at every single turn boundary forever. See compaction.ts.
  const compactionGate = createCompactionGate(config.compaction.max_consecutive_failures);
  let disposed = false;
  // The most recent turn this session started, kept AFTER it settles. Audio
  // outlives its turn, so a cancel landing in the tail window still has to
  // name a turn on its `playback.stop`; `inFlight` is already null by then.
  let lastTurnId: string | null = null;
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

  /**
   * Cut this session's outbound speech and command the client to flush its
   * playback queue. Unconditional on a user gesture BY DESIGN: the gateway
   * cannot see the client's playback buffer, which routinely still holds
   * seconds of audio after the gateway's own drain finished. Making the flush
   * conditional on gateway-side drain state is exactly how Stop became a
   * no-op at the end of a reply.
   */
  function stopPlayback(cutoff: CutoffKind): void {
    const cut = voice?.cancelAudio() ?? [];
    // Drains serialize (turn-voice.ts), so the FIRST still-live turn is the
    // one whose `turn.audio.start` the client last saw and is attributing
    // bytes to. Fall back to the in-flight turn, then to the last one to run.
    const turnId = cut[0] ?? inFlight?.turnId ?? lastTurnId;
    if (turnId === null) {
      log.info("session-runtime.playback.nothing-to-stop", {
        userId,
        sessionId,
        cutoff,
        reason: "no turn has ever run on this session",
      });
      return;
    }
    emitter.playbackStop(turnId, cutoff);
    log.info("session-runtime.playback.stop", { userId, sessionId, turnId, cutoff, cutTurnCount: cut.length });
  }

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
    stopPlayback,
    publishCommitted: () => feed.publishAll(),
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

  async function onTurnSettled(turnId: string, result: TurnOutcome, signal: AbortSignal): Promise<void> {
    // A DISPOSED RUNTIME DOES NO SETTLE WORK — the first statement in this
    // function, before anything can touch the store. `dispose()` already did
    // this turn's teardown (aborted its controller, cut its speech) and closed
    // the store handle; every line below reads or writes through that handle,
    // and this continuation is detached, so a throw here kills the process
    // rather than failing a request. Releasing the one-turn lock is the only
    // thing left worth doing. See this file's header.
    if (disposed) {
      inFlight = null;
      log.info("session-runtime.turn.settled-after-dispose", {
        userId,
        sessionId,
        turnId,
        completed: result.completed,
        reason: "runtime disposed while this turn was in flight — store handle is closed, socket is gone",
      });
      return;
    }

    // No more deltas for this turn — let the synthesizer finalize its tail.
    // Deliberately BEFORE the compaction await below: holding the turn's last
    // spoken words behind a summarizer round trip would stall the reply the
    // user is listening to. On an aborted turn this is already a no-op (the
    // abort closed the text queue — see turn-voice.ts's createChunkQueue).
    const speech = inFlight?.turnId === turnId ? inFlight.speech : null;
    speech?.end();

    // Turn boundary: release everything still outstanding on the committed
    // feed — including a tool tile whose `tool_result` is never coming (a
    // background dispatch) — BEFORE the terminal frame below. The client
    // drops its live bubble on `turn.completed`, so the committed twin has to
    // already be there or the reply visibly vanishes.
    feed.publishAll();

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

    // Compaction (spec §8, §3.4) runs HERE, in the one window where it is
    // safe, and nowhere else:
    //  - AFTER the terminal frame above, so the client never waits on a
    //    summarizer round trip to see its turn complete;
    //  - BEFORE `inFlight` is cleared, so the one-turn-at-a-time lock still
    //    holds and no new turn can start over a half-written model window.
    //    A `submit()` landing in this window still just appends and returns
    //    (the existing steer path) and is picked up by the next-turn-trigger
    //    check below — and compaction.ts's own race guard refuses to append
    //    a marker over it.
    // Cancellation invariants are unaffected by the longer in-flight window:
    // a naturally-completed turn is already `settled: true` and an aborted
    // one already has `signal.aborted`, so cancellation.ts's
    // `signal.aborted || turn.settled` guard no-ops either way (it still
    // reaches interrupt's unconditional `background.cancelAll()`).
    // No `disposed` re-check is needed to REACH here — the guard at the top of
    // this function is the only one, and nothing above awaits.
    try {
      if (compactionGate.shouldAttempt()) {
        const outcome = await maybeCompact({
          store,
          provider,
          sessionId,
          userId,
          turnId,
          config: config.compaction,
          summarizerPrompt: COMPACTION_SUMMARIZER_PROMPT,
          signal,
        });
        compactionGate.record(outcome);
      }
    } catch (err) {
      // maybeCompact's contract is "never throws" — a backstop only, so a
      // bug there can never wedge the one-turn guard open forever. It is also
      // where a `dispose()` landing DURING the summarizer round trip surfaces:
      // the store handle closes under it and its next append throws.
      log.error("session-runtime.compaction.threw", {
        userId,
        sessionId,
        turnId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    inFlight = null;

    // Re-checked, not redundant: `maybeCompact` above is an await, so a
    // `dispose()` can land inside it. `nextTurnTrigger()` reads the store.
    if (disposed) {
      log.info("session-runtime.turn.disposed-during-settle", {
        userId,
        sessionId,
        turnId,
        reason: "runtime disposed while this turn was compacting — no follow-up turn",
      });
      return;
    }

    // Advance the high-water mark to what THIS turn's iterations actually fed
    // the model, not the snapshot taken at its start. Without this, every
    // stimulus a mid-loop steer appended still reads as unprocessed here and
    // fires an empty phantom follow-up turn — one wasted LLM call and one
    // dangling local-tts WebSocket per steer. `Math.max` because a turn that
    // aborted before its first read reports 0.
    lastProcessedSeq = Math.max(lastProcessedSeq, result.consumedThroughSeq);
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

  /**
   * The ONE boundary where this runtime's async work is detached — nothing
   * awaits `runTurn`'s `.then` chain, so a rejection escaping it is a
   * process-level `unhandledRejection` and Bun exits on those. Per
   * .claude/rules/error-handling.md the catch belongs here and only here;
   * `onTurnSettled` itself is expected not to throw (the disposed case returns
   * early rather than throwing), which is what keeps this a backstop that
   * REPORTS an unexpected store/feed failure instead of a blanket that hides
   * routine ones. Mirrors session-handlers/stt-session.ts's `detach`.
   */
  function settle(turnId: string, result: TurnOutcome, signal: AbortSignal): void {
    onTurnSettled(turnId, result, signal).catch((err: unknown) => {
      log.error("session-runtime.turn.settle-threw", {
        userId,
        sessionId,
        turnId,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
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
    // The turn's own signal drives TTS — barge-in/interrupt abort it and the
    // audio dies with the turn, with no extra cancellation path (spec §4.7).
    const speech = voice ? voice.begin(turnId, controller.signal) : null;
    inFlight = { turnId, controller, settled: false, speech };
    lastTurnId = turnId;
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
        speech?.pushText(text);
      },
      onToolUpdate: (id, u) => {
        // Any onToolUpdate call is preceded by the loop committing this
        // iteration's narration (if it had any) to the store directly — see
        // react-loop.ts's `dispatchToolCalls`. That text is durable now, so
        // drop it from the cutoff accumulator; the next iteration's deltas
        // (if any) start counting fresh.
        turnText = "";
        emitter.toolUpdate(id, u);
        // The loop just made this iteration's narration and/or a tool
        // round-trip durable — publish whatever of it is now content-final.
        feed.publishSettled();
        // Flush what local-tts has buffered so a short pre-tool line is
        // spoken now, not after the tool round-trip. `onToolUpdate` fires on
        // EVERY status transition; `flush` is idempotent per toolCallId
        // (turn-voice.ts) so a tool call flushes exactly once.
        speech?.flush(u.toolCallId);
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
      (result) => settle(turnId, result, controller.signal),
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
        settle(turnId, { completed: false, iterations: 0, consumedThroughSeq: lastProcessedSeq }, controller.signal);
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
      feed.publishSettled();
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
    // Before `startTurn`, so the user's own bubble reaches the client ahead of
    // the `turn.started` it triggers — there is no optimistic client-side echo.
    feed.publishSettled();
    log.info("session-runtime.submit.start-turn", { userId, sessionId, kind: stimulus.kind, seq: entry.seq, turnId });
    startTurn(turnId, stimulusTrigger(stimulus));
  }

  /**
   * Wraps a no-argument public gesture so it becomes a WARN-logged no-op once
   * the runtime is disposed. Every one of them reaches the store (a cutoff
   * append, a committed-feed publish, a snapshot read) and the handle is
   * closed by then. `submit` keeps its own guard because it logs the stimulus
   * kind it dropped. See this file's header.
   */
  function whenLive(op: string, gesture: () => void): () => void {
    return () => {
      if (disposed) {
        log.warn("session-runtime.gesture.disposed", {
          userId,
          sessionId,
          op,
          reason: "runtime disposed; store handle is closed and the socket is gone",
        });
        return;
      }
      gesture();
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Aborting the in-flight turn is NOT enough, and is a no-op in exactly the
    // state that matters: a turn that completed naturally never aborted its own
    // controller and has already cleared `inFlight`, while its speech is still
    // draining. That drain has to be cut HERE or never — ws-session-configure.ts
    // mints a fresh `TurnVoice` (own empty `draining` map) on the next
    // session.configure, so no later gesture on the new runtime can reach it,
    // and it would keep pulling from local-tts and writing at a dead or
    // reassigned socket for the rest of the reply.
    //
    // No `playback.stop` goes with it: teardown is not a user gesture, and the
    // socket is closing or already belongs to the next runtime. `stopPlayback`
    // stays the cancel path's alone.
    const cut = voice?.cancelAudio() ?? [];
    log.info("session-runtime.dispose", {
      userId,
      sessionId,
      hadInFlight: inFlight !== null,
      cutTurnCount: cut.length,
    });
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
    bargeIn: whenLive("bargeIn", cancellation.bargeIn),
    interrupt: whenLive("interrupt", cancellation.interrupt),
    emitConversationSnapshot: whenLive("emitConversationSnapshot", () => feed.snapshot()),
  };
}
