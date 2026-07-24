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
//     Plan 3), KEEP background tasks running — the user is talking, not
//     cancelling the work they kicked off.
//   - interrupt (UI Stop / Esc): abort the turn (+ TTS, Plan 3) AND cancel
//     every background task for this session (`broker.background.cancelAll()`)
//     — explicit user cancel, nothing survives it. `cancelAll()` fires
//     unconditionally, even with no turn in flight: a background task
//     (`delegateTask`) outlives the turn that dispatched it (fire-and-steer,
//     Task 4/5) and Stop must still be able to reach it.
//
// react-loop.ts's contract on abort is "don't throw, don't partially commit"
// — it deliberately leaves the partial assistant text uncommitted (Task 6's
// header comment: stamping the cutoff kind is this layer's job). This module
// commits that partial as an `assistant` entry carrying `cutoff`, BEFORE
// aborting the controller, so the accumulated text is captured before the
// loop can possibly stop consuming it — an APPEND, so history stays
// immutable (Invariant A) and the client can render "interrupted here."
// Empty partial (abort landed before any text streamed, e.g. mid tool-call
// dispatch) commits nothing — an empty assistant entry is noise, not signal.
//
// Double-commit guard: `signal.aborted || turn.settled` is checked before
// committing/aborting.
//   - `signal.aborted`: a second bargeIn()/interrupt() call on the same
//     still-in-flight turn (or interrupt following a prior bargeIn) sees the
//     signal already aborted and skips straight to the (idempotent)
//     background-cancel step, never appending a second cutoff entry for the
//     same turn.
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
//     fire no `turnAborted` — but interrupt's unconditional `cancelAll()`
//     below still fires either way (background tasks outlive the turn).

import { getLog } from "../logging/logger.js";
import type { CutoffKind, NewSessionEntry } from "../store/entry-types.js";
import type { SessionStore } from "../store/session-store.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { UserId } from "../user-auth/user-id.js";
import type { TurnEmitter } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "cancellation"]);

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
}

export interface CancellationDeps {
  sessionId: string;
  userId: UserId;
  store: SessionStore;
  broker: ToolBroker;
  emitter: TurnEmitter;
  /** Current in-flight turn, or null if the runtime is idle. Read fresh on
   *  every call — cancellation always acts on whatever is running NOW, never
   *  a snapshot taken at construction time. */
  getInFlight: () => CancellableTurn | null;
}

function commitCutoffEntry(deps: CancellationDeps, turn: CancellableTurn, cutoff: CutoffKind): void {
  if (turn.text.length === 0) {
    log.info("cancellation.cutoff.no-partial-text", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: turn.turnId,
      cutoff,
    });
    return;
  }

  const entry: NewSessionEntry = {
    sessionId: deps.sessionId,
    turnId: turn.turnId,
    kind: "assistant",
    createdAt: Date.now(),
    text: turn.text,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff,
    compactedThroughSeq: null,
  };
  const appended = deps.store.append(entry);
  log.info("cancellation.cutoff.committed", {
    userId: deps.userId,
    sessionId: deps.sessionId,
    turnId: turn.turnId,
    cutoff,
    seq: appended.seq,
    textLength: turn.text.length,
  });
}

function abortTurn(deps: CancellationDeps, cutoff: CutoffKind, cancelBackground: boolean): void {
  const turn = deps.getInFlight();

  if (!turn) {
    log.info("cancellation.no-turn-in-flight", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      cutoff,
      cancelBackground,
    });
  } else if (turn.controller.signal.aborted || turn.settled) {
    // Either already aborted by a prior bargeIn()/interrupt() on this same
    // turn (the cutoff entry, if any, was already committed then), or the
    // turn already reached a natural terminal commit (the
    // terminal-completion race — see the module doc comment above). Either
    // way: commit nothing, fire no turnAborted, skip straight to the
    // background step below so a follow-up interrupt() still reaches
    // cancelAll() without double-appending or racing turnCompleted.
    log.info("cancellation.already-aborted", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: turn.turnId,
      cutoff,
      cancelBackground,
      alreadyAborted: turn.controller.signal.aborted,
      alreadySettled: turn.settled,
    });
  } else {
    commitCutoffEntry(deps, turn, cutoff);
    turn.controller.abort();
    deps.emitter.turnAborted(turn.turnId, cutoff);
    log.info("cancellation.abort", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      turnId: turn.turnId,
      cutoff,
      cancelBackground,
    });
  }

  if (cancelBackground) {
    deps.broker.background.cancelAll();
    log.info("cancellation.background.cancel-all", { userId: deps.userId, sessionId: deps.sessionId, cutoff });
  }
}

export function createCancellationControllers(deps: CancellationDeps): CancellationControllers {
  return {
    bargeIn(): void {
      abortTurn(deps, "barge-in", false);
    },
    interrupt(): void {
      abortTurn(deps, "interrupt", true);
    },
  };
}
