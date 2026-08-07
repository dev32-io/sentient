// TaskListProjector — the live tool/task list the composer strip renders, and
// the authority on how long each row lives.
//
// WHY THE GATEWAY OWNS THE LIFETIME. Tool activity used to render as pills
// attached to a chat bubble, which forced every client to answer "which bubble
// does this pill belong to" — a question with no stable answer once a mid-turn
// steer can split a reply. The strip has no anchor, so the only remaining
// question is when a row disappears, and that is a fact only the gateway holds:
//
//   foreground — awaited by the ReAct loop, so anything still running when the
//                turn ends is an orphan. Dies with the turn.
//   background — a `delegateTask` dispatch. It outlives the turn that spawned
//                it in every case and nothing cancels it (tools/delegate-task.ts),
//                so it survives the boundary and leaves on its own terminal
//                `delegation.progress`.
//
// Pure: no I/O, no wall clock of its own. The caller emits `tasklist.state`
// whenever a mutator returns true.

import type { TaskListItem } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ToolUpdate } from "./react-loop.js";
import type { DelegationProgress } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "task-list"]);

const STATUS_RUNNING = "running";

export interface TaskListProjector {
  /** The rows to publish, oldest first. */
  items(): TaskListItem[];
  /** The turn the list belongs to, or null when only background rows remain. */
  turnId(): string | null;
  onTurnStarted(turnId: string): boolean;
  onToolUpdate(turnId: string, update: ToolUpdate): boolean;
  onDelegationProgress(progress: DelegationProgress): boolean;
  onTurnEnded(turnId: string): boolean;
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
      // A new turn's strip starts empty of FOREGROUND work. Background rows
      // from an earlier turn are still running and stay.
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
      for (const [id, row] of rows) {
        if (row.kind === "foreground") rows.delete(id);
      }
      currentTurnId = null;
      log.debug("task-list.turn-ended", { turnId, rows: rows.size });
      // Always a change: `turnId` is part of the published frame and it just
      // went null, even in the case where no row was dropped.
      return true;
    },
  };
}
