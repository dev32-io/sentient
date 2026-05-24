import type { TaskStatus } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TaskSnapshotItem {
  readonly taskId: string;
  readonly toolName: string;
  readonly cycleId: string;
  readonly status: TaskStatus;
  /** Auto-derived short preview of the tool's args. */
  readonly argsPreview: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
}

export interface TaskStatusConnectorConfig {
  /** Called on every individual update. */
  onUpdate?: (item: TaskSnapshotItem) => void;
  /** Called whenever the task list changes — ordered by startedAt ascending. */
  onList?: (items: readonly TaskSnapshotItem[]) => void;
}

// ---------------------------------------------------------------------------
// TaskStatusConnector — session-scoped live task list.
//
// Capability: "task.status"
// Direction: status (observer; no per-task outbound protocol from here)
//
// Receives:
//   - task.update  (one on register, one on deregister; dedups by taskId)
//
// Exposes ordered list by startedAt ascending. Terminal states stay in
// the list — UI can filter out if it only wants running tasks.
// ---------------------------------------------------------------------------

export class TaskStatusConnector implements Connector {
  readonly capability = "task.status";
  readonly kind = "status" as const;

  private readonly config: TaskStatusConnectorConfig;
  private unsubs: (() => void)[] = [];
  private tasks = new Map<string, TaskSnapshotItem>();

  constructor(config: TaskStatusConnectorConfig = {}) {
    this.config = config;
  }

  list(): readonly TaskSnapshotItem[] {
    return [...this.tasks.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  attach(sdk: SentientSDKInternal): void {
    this.tasks = new Map();

    this.unsubs.push(
      sdk.onMessage("task.update", (msg: unknown) => {
        const m = msg as {
          taskId?: string;
          toolName?: string;
          cycleId?: string;
          status?: TaskStatus;
          argsPreview?: string;
          startedAtMs?: number;
          endedAtMs?: number;
        };
        if (!m.taskId || !m.toolName || !m.cycleId || !m.status || m.startedAtMs === undefined) return;
        const item: TaskSnapshotItem = {
          taskId: m.taskId,
          toolName: m.toolName,
          cycleId: m.cycleId,
          status: m.status,
          argsPreview: m.argsPreview ?? "",
          startedAtMs: m.startedAtMs,
          ...(m.endedAtMs !== undefined ? { endedAtMs: m.endedAtMs } : {}),
        };
        this.tasks.set(item.taskId, item);
        this.config.onUpdate?.(item);
        this.config.onList?.(this.list());
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.tasks = new Map();
  }
}
