import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "cerebrum", "task-mirror"]);

// ---------------------------------------------------------------------------
// TaskMirror — ephemeral live table of tool calls for UI task.update
// messages.
// Per spec v4 §5.7: tracks running/completed tasks per cycle; clearCycle
// cancels orphaned running tasks on cycle abort.
// ---------------------------------------------------------------------------

export interface TaskRecord {
  taskId: string;
  toolName: string;
  cycleId: string;
  argsPreview: string;
  status: "running" | "finished" | "cancelled" | "failed";
  startedAtMs: number;
  endedAtMs?: number;
}

export interface TaskMirror {
  /** Register a new task as running. Returns the created record. */
  start(record: Omit<TaskRecord, "status" | "startedAtMs" | "endedAtMs">): TaskRecord;
  /** Mark a task as finished or failed. Returns null if not found. */
  finish(taskId: string, status: "finished" | "failed", endedAtMs?: number): TaskRecord | null;
  /** Cancel a running task. Returns null if not found. */
  cancel(taskId: string, endedAtMs?: number): TaskRecord | null;
  /** Snapshot all current records (running + terminal). */
  snapshot(): readonly TaskRecord[];
  /** Cancel all running tasks for a given cycle (cycle abort). */
  clearCycle(cycleId: string): void;
}

export function createTaskMirror(): TaskMirror {
  const records = new Map<string, TaskRecord>();

  return {
    start(input) {
      const r: TaskRecord = {
        ...input,
        status: "running",
        startedAtMs: Date.now(),
      };
      log.debug("start", { taskId: r.taskId, toolName: r.toolName, cycleId: r.cycleId });
      records.set(r.taskId, r);
      return { ...r };
    },

    finish(taskId, status, endedAtMs = Date.now()) {
      const r = records.get(taskId);
      if (!r) {
        log.debug("finish.unknown", { taskId });
        return null;
      }
      const updated = { ...r, status, endedAtMs };
      records.set(taskId, updated);
      log.debug("finish", { taskId, status });
      return { ...updated };
    },

    cancel(taskId, endedAtMs = Date.now()) {
      const r = records.get(taskId);
      if (!r) return null;
      const updated = { ...r, status: "cancelled" as const, endedAtMs };
      records.set(taskId, updated);
      log.debug("cancel", { taskId });
      return { ...updated };
    },

    snapshot() {
      return [...records.values()].map((r) => ({ ...r }));
    },

    clearCycle(cycleId) {
      const now = Date.now();
      let cancelledCount = 0;
      for (const [id, r] of records) {
        if (r.cycleId === cycleId && r.status === "running") {
          records.set(id, { ...r, status: "cancelled", endedAtMs: now });
          cancelledCount++;
        }
      }
      log.debug("clearCycle", { cycleId, cancelledCount });
    },
  };
}
