// TaskListProjector — the current state of tasks (foreground and background)
// the composer strip renders, retained until the next turn replaces it, and
// the authority on how long each row lives.
//
// WHY THE GATEWAY OWNS THE LIFETIME. Tool activity used to render as pills
// attached to a chat bubble, which forced every client to answer "which bubble
// does this pill belong to" — a question with no stable answer once a mid-turn
// steer can split a reply. The strip has no anchor, so the only remaining
// question is when a row disappears, and that is a fact only the gateway holds:
//
//   foreground — awaited by the ReAct loop. It reaches a terminal status
//                (done/error) by the turn's own boundary, but the ROW STAYS —
//                the whole point of the strip is that a person can look back
//                at what a turn actually did. `onTurnStarted` is the ONLY
//                place a foreground row is ever deleted, when the next turn
//                begins and the strip empties for new work.
//   background — a `delegateTask` dispatch. It outlives the turn that spawned
//                it in every case and nothing cancels it (tools/delegate-task.ts),
//                so it survives every turn boundary too, and leaves only on its
//                own terminal `delegation.progress`.
//
// A foreground call still in flight when its turn is cut off (barge-in/
// interrupt) is the one case that does NOT settle on its own — react-loop.ts
// stops without ever reporting a terminal status for it. `onToolCallsClosed`
// exists for exactly that gap: cancellation.ts drives it once it has decided
// which calls were left unreplied, so a cut-off row still reaches "error"
// instead of sitting at "running" for the rest of the session.
//
// `onToolCallsClosed` only ever runs for the two user gestures. A turn can
// also end by provider failure, a request timeout, or an unexpected throw
// out of the ReAct loop — none of which route through cancellation.ts — and
// SessionRuntime's own settle continuation is the one place that sees every
// one of those exits alike. `terminalizeOrphanedForeground` is that general
// backstop: the ReAct loop awaits every foreground dispatch inside its own
// turn, so by the time the turn has settled, ANY row still "foreground" +
// "running" is by definition an orphan, regardless of which exit produced
// it. On the two gestures it is a clean no-op — `onToolCallsClosed` already
// closed everything before `controller.abort()` — so this subsumes that path
// rather than duplicating it.
//
// Pure: no I/O, no wall clock of its own. The caller emits `tasklist.state`
// whenever a mutator returns true.

import type { TaskListItem } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ToolUpdate } from "./react-loop.js";
import type { DelegationProgress } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "task-list"]);

const STATUS_RUNNING = "running";
/** What `onToolCallsClosed` stamps a cut-off row with. Not "cancelled" — the
 *  wire vocabulary (`turnToolStatusSchema`) is `running | done | error` only,
 *  and a call the turn was cut off before recording a result for is exactly
 *  what "error" means here: it produced no result. */
const STATUS_ERROR = "error";

export interface TaskListProjector {
  /** The rows to publish, oldest first. */
  items(): TaskListItem[];
  /** The turn the list belongs to, or null when only background rows remain. */
  turnId(): string | null;
  onTurnStarted(turnId: string): boolean;
  onToolUpdate(turnId: string, update: ToolUpdate): boolean;
  onDelegationProgress(progress: DelegationProgress): boolean;
  onTurnEnded(turnId: string): boolean;
  /** Drives every listed row to a terminal "error" status, leaving anything
   *  already terminal or absent untouched. The one call site is
   *  cancellation.ts, for the tool calls a barge-in/interrupt closed with a
   *  synthetic `tool_result` — see the module header. */
  onToolCallsClosed(toolCallIds: readonly string[]): boolean;
  /**
   * Drives every FOREGROUND row still "running" to "error" — the general
   * backstop for a turn that settles WITHOUT going through
   * cancellation.ts's `onToolCallsClosed` (provider failure, a request
   * timeout, an unexpected throw out of the ReAct loop). See the module
   * header. Background rows are untouched: they are exempt from every
   * turn boundary by design and leave only via `onDelegationProgress`.
   *
   * The one call site is SessionRuntime's turn-settle continuation, driven
   * alongside `onTurnEnded` for every turn regardless of how it ended.
   * `turnId` is carried for logging only — a foreground row can only ever
   * belong to the turn currently in flight, so nothing here needs to gate
   * on it to find the right rows.
   */
  terminalizeOrphanedForeground(turnId: string): boolean;
}

export interface TaskListProjectorDeps {
  /** Injected so the projector stays pure and its lifetime rules are testable
   *  without a real clock. */
  readonly now: () => number;
}

export function createTaskListProjector(deps: TaskListProjectorDeps): TaskListProjector {
  // Insertion-ordered: the strip renders dispatch order, which is the order the
  // loop actually called the tools in.
  const rows = new Map<string, TaskListItem>();
  let currentTurnId: string | null = null;

  function snapshot(): TaskListItem[] {
    return [...rows.values()];
  }

  function sameRow(a: TaskListItem | undefined, b: TaskListItem): boolean {
    if (a === undefined) return false;
    return (
      a.status === b.status &&
      a.toolName === b.toolName &&
      a.kind === b.kind &&
      a.argsPreview === b.argsPreview &&
      a.endedAtMs === b.endedAtMs
    );
  }

  /** Swaps a row's key in place, keeping its ORIGINAL dispatch position — the
   *  strip renders insertion order, and a plain delete-then-set would move a
   *  promoted row to the back, behind anything dispatched between the
   *  placeholder and its promotion. */
  function promoteRow(oldId: string, newId: string, row: TaskListItem): void {
    const entries: Array<[string, TaskListItem]> = [];
    for (const [key, value] of rows) {
      entries.push(key === oldId ? [newId, row] : [key, value]);
    }
    rows.clear();
    for (const [key, value] of entries) rows.set(key, value);
  }

  return {
    items: snapshot,
    turnId: () => currentTurnId,

    onTurnStarted(turnId: string): boolean {
      // A new turn's strip starts empty of FOREGROUND work — the SOLE place a
      // foreground row is ever cleared (onTurnEnded retains them; see the
      // module header). Background rows from an earlier turn are still
      // running and stay.
      let changed = currentTurnId !== turnId;
      for (const [id, row] of rows) {
        if (row.kind === "foreground") {
          rows.delete(id);
          changed = true;
        }
      }
      currentTurnId = turnId;
      if (changed) log.debug("task-list.turn-started", { turnId, rows: rows.size });
      return changed;
    },

    onToolUpdate(turnId: string, update: ToolUpdate): boolean {
      const isBackground = update.taskId !== undefined;
      // Ownership guard, mirrors onTurnEnded: a FOREGROUND update for a turn
      // that is not (or no longer) current is stale — the ReAct loop only
      // awaits foreground calls inside their own turn, so nothing legitimate
      // reports one late. A BACKGROUND update is exempt: the promotion below
      // fires with the SAME turnId the pre-resolution call used, and that
      // turn can end before the promotion lands — the row must still land,
      // or a delegateTask call that is designed to outlive its turn would
      // silently lose its row at exactly the moment it needs it most.
      if (!isBackground && turnId !== currentTurnId) {
        log.debug("task-list.tool-update.stale-turn", { turnId, currentTurnId });
        return false;
      }

      const id = update.taskId ?? update.toolCallId;

      // PROMOTION. A background dispatch fires `onToolUpdate` TWICE, and the
      // two calls carry different keys. `dispatchToolCalls` fires a
      // toolCallId-keyed "running" update right after appending the tool_call
      // and BEFORE `broker.dispatch()` resolves — no taskId yet, nobody knows
      // the call is background — then `appendBackgroundReceipt` fires a SECOND
      // "running" update once the resolved taskId exists. Left alone those two
      // land under two different keys: a phantom foreground row stuck at
      // "running" forever, next to the real background row. Fold the
      // placeholder into the promoted row instead — same call, same actual
      // start time — so the strip only ever shows one row for it.
      // `ToolUpdate`'s doc (react-loop.ts) states this two-call sequence.
      const placeholderId = isBackground && update.toolCallId !== id ? update.toolCallId : null;
      const placeholder = placeholderId !== null ? rows.get(placeholderId) : undefined;
      const existing = rows.get(id);
      const isTerminal = update.status !== STATUS_RUNNING;
      const next: TaskListItem = {
        id,
        toolName: update.toolName,
        kind: isBackground ? "background" : "foreground",
        status: update.status,
        argsPreview: update.argsPreview ?? "",
        startedAtMs: existing?.startedAtMs ?? placeholder?.startedAtMs ?? deps.now(),
        ...(isTerminal ? { endedAtMs: deps.now() } : {}),
      };
      if (placeholder === undefined && sameRow(existing, next)) return false;

      if (placeholderId !== null && placeholder !== undefined) {
        promoteRow(placeholderId, id, next);
      } else {
        rows.set(id, next);
      }
      // NOTE: currentTurnId is deliberately NOT reassigned here. For a
      // foreground update the guard above already proved turnId ===
      // currentTurnId, so it would be a no-op; for a background update
      // (exempt from the guard) writing it would wrongly resurrect
      // currentTurnId after onTurnEnded set it back to null, undoing the
      // "no turn owns the list any more" signal a background-only strip
      // depends on.
      // argsPreview is user content and is never logged (logging rules).
      log.debug("task-list.tool-update", {
        turnId,
        id,
        kind: next.kind,
        status: next.status,
        promoted: placeholder !== undefined,
        rows: rows.size,
      });
      return true;
    },

    onDelegationProgress(progress: DelegationProgress): boolean {
      const existing = rows.get(progress.taskId);
      if (existing === undefined) return false;
      if (progress.status === STATUS_RUNNING) {
        if (existing.status === STATUS_RUNNING) return false;
        rows.set(progress.taskId, { ...existing, status: progress.status });
        return true;
      }
      // Terminal: the delegation is over, so the row leaves the strip. Its
      // RESULT arrives separately as a stimulus that starts its own turn — the
      // strip is live state, never a record.
      rows.delete(progress.taskId);
      log.debug("task-list.delegation-settled", {
        taskId: progress.taskId,
        status: progress.status,
        rows: rows.size,
      });
      return true;
    },

    onTurnEnded(turnId: string): boolean {
      if (currentTurnId !== turnId) return false;
      // Rows are deliberately NOT dropped here any more — the strip is
      // retained state, not a live-only view, and a person can still look
      // back at what this turn did until the next one starts and clears it
      // (`onTurnStarted` — see the module header).
      currentTurnId = null;
      log.debug("task-list.turn-ended", { turnId, rows: rows.size });
      // Always a change: `turnId` is part of the published frame and it just
      // went null, even in the case where no row's status changed.
      return true;
    },

    onToolCallsClosed(toolCallIds: readonly string[]): boolean {
      let changed = false;
      for (const id of toolCallIds) {
        const existing = rows.get(id);
        // Absent (never got a row) or already terminal (its real result
        // landed before the abort did) — nothing to do either way.
        if (existing === undefined || existing.status !== STATUS_RUNNING) continue;
        rows.set(id, { ...existing, status: STATUS_ERROR, endedAtMs: deps.now() });
        changed = true;
      }
      if (changed) log.debug("task-list.tool-calls-closed", { toolCallIds, rows: rows.size });
      return changed;
    },

    terminalizeOrphanedForeground(turnId: string): boolean {
      let changed = false;
      for (const [id, row] of rows) {
        if (row.kind !== "foreground" || row.status !== STATUS_RUNNING) continue;
        rows.set(id, { ...row, status: STATUS_ERROR, endedAtMs: deps.now() });
        changed = true;
      }
      if (changed) {
        log.warn("task-list.turn-settled.orphaned-foreground", {
          turnId,
          rows: rows.size,
          reason: "turn settled with a foreground row still running — no exit routed it through onToolCallsClosed",
        });
      }
      return changed;
    },
  };
}
