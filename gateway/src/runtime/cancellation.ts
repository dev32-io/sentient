// Cancellation (spec §4.7, Plan 2 Task 8) — barge-in vs. interrupt.
//
// Two distinct user gestures, kept as two distinct methods (an explicit
// prior-art lesson: a do-everything "cancel" that fans out silently caused
// bugs). Both hit the current turn's `AbortController` from OUTSIDE
// react-loop.ts — the loop only ever OBSERVES the abort (checks
// `signal.aborted`, stops without throwing); this module never reaches into
// the loop's internals.
//
//   - barge-in  (mic onset, Plan 3 wires the trigger): abort the turn (+ TTS,
//     Plan 3).
//   - interrupt (UI Stop / Esc): abort the turn (+ TTS, Plan 3).
//
// NEITHER GESTURE TOUCHES BACKGROUND TASKS, and the difference between them is
// now only the `cutoff` kind stamped on the committed partial. A background
// task (`delegateTask`) outlives the turn that dispatched it in EVERY case, and
// nothing cancels it — the lost-task watchdog is the only backstop. See
// tools/delegate-task.ts's header for the contract and the trade it accepts.
//
// Interrupt used to fan out into `broker.background.cancelAll()`. It was the
// only production caller, and `cancelAll` is gone with it: "Stop" cancelling
// every delegation in the session was a blanket sweep no user asked for, and
// the per-task `cancel` handles a named, model-facing task-management tool will
// want are still registered.
//
// react-loop.ts's contract on abort is "don't throw, don't partially commit"
// — it deliberately leaves the partial assistant text uncommitted (Task 6's
// header comment: stamping the cutoff kind is this layer's job). This module
// commits that partial as an `assistant` entry carrying `cutoff`, BEFORE
// aborting the controller, so the accumulated text is captured before the
// loop can possibly stop consuming it — an APPEND, so history stays
// immutable (Invariant A) and the client can render "interrupted here."
//
// AN EMPTY PARTIAL IS STILL A MARKER, when the turn already produced durable
// output. The partial accumulator is cleared the moment the loop commits an
// iteration's narration and dispatches a tool (session-runtime.ts's
// `onToolUpdate`), so a Stop pressed DURING tool dispatch — the single most
// common way to interrupt a ReAct turn — arrives here with `text === ""`.
// Committing nothing then left the cut off the durable record entirely: the
// live `turn.aborted` frame marked the running bubble, and the next refetch or
// reconnect rendered the turn as though it had ended on its own. Both clients
// already render an assistant entry that is empty but CARRIES a cutoff as a
// bare "interrupted" marker (webui hooks/cycle-helpers.ts, mobile-sdk
// StateDeriver.committedMessage), so the empty entry is the designed shape for
// exactly this case. Only a turn that produced NOTHING at all skips it — there
// a marker would annotate a turn the user never saw start.
//
// UNREPLIED TOOL CALLS ARE CLOSED FIRST, and that ordering is the whole point
// of doing it here rather than in react-loop.ts. A turn cut off between
// `broker.dispatch` returning and its `tool_result` being appended leaves a
// bare `tool_call` in the store, and an unreplied call is poison twice over:
// the client tile renders "cancelled", which StateDeriver maps to a
// PERMANENTLY spinning pill, and `projectForModel` DROPS the call from every
// later turn's messages — so the model reads its own narration with the action
// erased, and the drop re-WARNs on every iteration for the life of the session.
// This module runs synchronously BEFORE `controller.abort()`, so its appends
// land while react-loop.ts is still parked on its await: the synthetic
// `tool_result` immediately follows its `tool_call`, which is what
// `projectForModel` requires (it pairs a call only with the run of results
// DIRECTLY after it). Closing them from react-loop.ts's post-abort branch
// instead would put the cutoff entry between the pair and drop the call anyway.
//
// TWO CONCERNS, NOT ONE. Committing a cutoff entry (+ firing `turnAborted`)
// is about the TURN; flushing playback is about AUDIO — and audio OUTLIVES
// its turn. `onTurnSettled` closes only the TTS text queue; the drain chained
// on TurnVoice's `tail` keeps writing frames for as long as playback lasts,
// and a turn that completed NATURALLY never aborts its own controller. So a
// gesture landing in that tail window has no turn to abort and nothing to
// commit — but absolutely must still stop the audio. `stopPlayback` therefore
// runs on EVERY call, outside the guard below, while the guard keeps owning
// the commit decision alone. Fusing the two is what made UI Stop and mic-onset
// barge-in dead for the last seconds of every spoken reply.
//
// Double-commit guard: `signal.aborted || turn.settled` is checked before
// committing/aborting.
//   - `signal.aborted`: a second bargeIn()/interrupt() call on the same
//     still-in-flight turn (or interrupt following a prior bargeIn) sees the
//     signal already aborted and commits nothing, never appending a second
//     cutoff entry for the same turn.
//   - `turn.settled`: the terminal-completion race. A turn that finishes
//     NATURALLY never sets `signal.aborted` — its final text commits
//     directly in react-loop.ts's terminal branch (not through
//     `onToolUpdate`), and `inFlight` is only cleared asynchronously in
//     session-runtime.ts's `onTurnSettled`, a `.then()` microtask after
//     `runTurn` resolves. A bargeIn()/interrupt() landing in the window
//     between "terminal text committed" and "inFlight cleared" would
//     otherwise see `signal.aborted === false` and `turn.text` still holding
//     the already-committed text, re-committing it as a bogus second cutoff
//     entry and firing a spurious `turnAborted` racing the legitimate
//     `turnCompleted` for the same turnId. `onTurnCommitting`
//     (react-loop.ts) fires synchronously the instant the terminal entry is
//     appended, letting session-runtime.ts mark the turn `settled` before
//     any of that can happen. `turn.settled` folds into this same guard
//     because the required behavior is identical: commit nothing further,
//     fire no `turnAborted`.

import { getLog } from "../logging/logger.js";
import type { CutoffKind, NewSessionEntry, SessionEntry } from "../store/entry-types.js";
import type { SessionStore } from "../store/session-store.js";
import type { UserId } from "../user-auth/user-id.js";
import type { TurnEmitter } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "cancellation"]);

/**
 * Result text for a `tool_result` synthesized because the turn was cut off
 * before the real one was recorded.
 *
 * Addressed to the MODEL — this is what it reads in place of the result on
 * every later turn — so it states the two things the model cannot otherwise
 * know: the round trip did not complete, and whether the tool took effect is
 * genuinely unknown. The call was already in flight when the abort landed, so
 * claiming it "did not run" would be a guess, and a side-effecting tool that
 * DID run must never be silently re-issued on that basis.
 */
const CUT_OFF_TOOL_RESULT =
  "The user stopped this turn before the tool's result was recorded. Whether it took effect is unknown — say so rather than assuming, and confirm before repeating a call that changes anything.";

/** The kinds that mean a turn put something durable on the record. A turn's
 *  own trigger (`user` / `trigger`) is what STARTED it and does not count. */
const TURN_OUTPUT_KINDS: ReadonlySet<string> = new Set(["assistant", "tool_call", "tool_result"]);

export interface CancellationControllers {
  /** Mic onset — the user starts speaking over the assistant. */
  bargeIn(): void;
  /** UI Stop / Esc. */
  interrupt(): void;
}

/** The in-flight turn's cancellable state, narrowed to exactly what this
 *  module needs — it never reaches into `SessionRuntime`'s private fields
 *  directly, only what the runtime hands it via `getInFlight`. */
export interface CancellableTurn {
  turnId: string;
  controller: AbortController;
  /** WHICH REPLY the cut-off text belongs to (session-runtime.ts's
   *  `InFlightTurn.replyId`). The partial committed below is the last stretch
   *  of the reply the person was watching, not a reply of its own: the client
   *  projection folds every stretch sharing this id into ONE bubble and stamps
   *  the cutoff on it (store/client-projection.ts). Committed without it, a
   *  barge-in draws a second bubble against a single live one. */
  replyId: string;
  /** Text streamed so far for the turn's current, not-yet-committed
   *  iteration. The runtime resets this to "" every time the loop itself
   *  commits an iteration's text (narration or terminal) — see
   *  session-runtime.ts's `onTextDelta`/`onToolUpdate`/`onTurnCommitting`
   *  wiring — so this always holds exactly the not-yet-durable partial,
   *  never text that's already safely in the store. */
  text: string;
  /** True the instant the turn reached a natural terminal commit
   *  (react-loop.ts's `onTurnCommitting`, wired by session-runtime.ts),
   *  even though the runtime's `inFlight` marker isn't cleared until the
   *  async `onTurnSettled` continuation runs after `runTurn`'s promise
   *  settles. A bargeIn()/interrupt() landing in that window must treat the
   *  turn as already-cut-off-equivalent: commit nothing further, fire no
   *  `turnAborted` — see `abortTurn` below. */
  settled: boolean;
  /**
   * The store's high-water seq at the instant this turn started
   * (session-runtime.ts's `lastProcessedSeq` snapshot). Bounds the read that
   * finds this turn's unreplied tool calls to the turn's OWN entries — a full
   * `readSession` would grow with the conversation, and this runs on a user
   * gesture that must feel instant.
   */
  startedAfterSeq: number;
}

export interface CancellationDeps {
  sessionId: string;
  userId: UserId;
  store: SessionStore;
  emitter: TurnEmitter;
  /** Current in-flight turn, or null if the runtime is idle. Read fresh on
   *  every call — cancellation always acts on whatever is running NOW, never
   *  a snapshot taken at construction time. */
  getInFlight: () => CancellableTurn | null;
  /** Halt this session's outbound speech and tell the client to flush its
   *  playback queue. Runs on EVERY gesture, including one that lands after
   *  the turn settled while its audio is still draining — see the header. */
  stopPlayback: (cutoff: CutoffKind) => void;
  /** Publish newly committed entries on the client's committed feed. Called
   *  right after a cutoff entry is appended so the interrupted bubble reaches
   *  the client immediately, rather than whenever the loop happens to unwind. */
  publishCommitted: () => void;
}

/** This turn's own entries, newest-last. Bounded by `startedAfterSeq`; the
 *  turnId filter drops a steer's stimulus, which shares the seq range. */
function turnEntries(deps: CancellationDeps, turn: CancellableTurn): SessionEntry[] {
  return deps.store.readSince(deps.sessionId, turn.startedAfterSeq).filter((e) => e.turnId === turn.turnId);
}

/** Tool-call ids this turn appended with no `tool_result` after them, in
 *  dispatch order. The question exists for the MODEL projection's sake — an
 *  unanswered call is dropped from the next request's `messages[]` — not for
 *  any client feed; tool entries have not been client-facing since the feed's
 *  tool item was retired. */
function unrepliedToolCalls(entries: readonly SessionEntry[]): SessionEntry[] {
  const replied = new Set<string>();
  for (const e of entries) {
    if (e.kind === "tool_result" && e.toolCallId !== null) replied.add(e.toolCallId);
  }
  return entries.filter((e) => e.kind === "tool_call" && e.toolCallId !== null && !replied.has(e.toolCallId));
}

/**
 * Append a `tool_result` for every call this turn left unanswered, so the cut
 * turn's record is a complete round trip. Returns how many were closed.
 *
 * Runs BEFORE the cutoff entry and before `controller.abort()` — see the module
 * header for why that order is load-bearing rather than incidental.
 */
function closeUnrepliedToolCalls(deps: CancellationDeps, turn: CancellableTurn, cutoff: CutoffKind): SessionEntry[] {
  const entries = turnEntries(deps, turn);
  for (const call of unrepliedToolCalls(entries)) {
    const appended = deps.store.append({
      ...blankEntry(deps.sessionId, turn.turnId),
      kind: "tool_result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      toolArgs: CUT_OFF_TOOL_RESULT,
    });
    log.info("cancellation.tool-call.closed", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: turn.turnId,
      cutoff,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      seq: appended.seq,
      reason: "cut off before its result was recorded — closing the round trip so the model keeps the call",
    });
  }
  return entries;
}

function blankEntry(sessionId: string, turnId: string): NewSessionEntry {
  return {
    sessionId,
    turnId,
    replyId: null,
    kind: "assistant",
    createdAt: Date.now(),
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  };
}

/**
 * Commit the cutoff marker for this turn.
 *
 * [priorEntries] are the turn's entries as of the abort, read once by
 * `closeUnrepliedToolCalls`. An empty partial still commits when they show the
 * turn produced durable output — see the module header.
 */
function commitCutoffEntry(
  deps: CancellationDeps,
  turn: CancellableTurn,
  cutoff: CutoffKind,
  priorEntries: readonly SessionEntry[],
): void {
  const hasOutput = priorEntries.some((e) => TURN_OUTPUT_KINDS.has(e.kind));
  if (turn.text.length === 0 && !hasOutput) {
    log.info("cancellation.cutoff.nothing-to-mark", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: turn.turnId,
      cutoff,
      reason: "the turn committed no output before the abort — a marker would annotate an empty turn",
    });
    return;
  }

  const entry: NewSessionEntry = {
    ...blankEntry(deps.sessionId, turn.turnId),
    // The reply this partial ENDS, never a new one — see `CancellableTurn`.
    // The `tool_result`s closed above deliberately keep the blank's null: they
    // are round-trip bookkeeping, not part of any bubble.
    replyId: turn.replyId,
    kind: "assistant",
    text: turn.text,
    cutoff,
  };
  const appended = deps.store.append(entry);
  log.info("cancellation.cutoff.committed", {
    userId: deps.userId,
    sessionId: deps.sessionId,
    turnId: turn.turnId,
    cutoff,
    seq: appended.seq,
    textLength: turn.text.length,
    markerOnly: turn.text.length === 0,
  });
}

function abortTurn(deps: CancellationDeps, cutoff: CutoffKind): void {
  const turn = deps.getInFlight();

  if (!turn) {
    log.info("cancellation.no-turn-in-flight", { userId: deps.userId, sessionId: deps.sessionId, cutoff });
  } else if (turn.controller.signal.aborted || turn.settled) {
    // Either already aborted by a prior bargeIn()/interrupt() on this same
    // turn (the cutoff entry, if any, was already committed then), or the
    // turn already reached a natural terminal commit (the
    // terminal-completion race — see the module doc comment above). Either
    // way: commit nothing, fire no turnAborted — and still stop the audio
    // below, because speech outlives its turn.
    log.info("cancellation.already-aborted", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: turn.turnId,
      cutoff,
      alreadyAborted: turn.controller.signal.aborted,
      alreadySettled: turn.settled,
    });
  } else {
    // Order is the contract: close the tool round trips, THEN mark the cut,
    // THEN abort. See the module header — a cutoff entry landing between a
    // tool_call and its result is what drops the call from the model's view.
    const priorEntries = closeUnrepliedToolCalls(deps, turn, cutoff);
    commitCutoffEntry(deps, turn, cutoff, priorEntries);
    deps.publishCommitted();
    turn.controller.abort();
    deps.emitter.turnAborted(turn.turnId, cutoff);
    log.info("cancellation.abort", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: turn.turnId,
      cutoff,
    });
  }

  // Outside the guard on purpose: speech outlives its turn, so every branch
  // above — including "no turn" and "already settled" — still has audio to
  // stop. Ordered after the turn branch so a cut-off turn's `turn.aborted`
  // feed marker precedes its `playback.stop`, the order both client SDKs and
  // ws-turn-emitter.test.ts pin.
  deps.stopPlayback(cutoff);
}

export function createCancellationControllers(deps: CancellationDeps): CancellationControllers {
  return {
    bargeIn(): void {
      abortTurn(deps, "barge-in");
    },
    interrupt(): void {
      abortTurn(deps, "interrupt");
    },
  };
}
