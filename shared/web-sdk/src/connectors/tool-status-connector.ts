import type { TurnToolStatus } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "tool-status"]);

export interface ToolCallSnapshotItem {
  /** Dedup key. The same id the loop and the PDP use for this call. */
  readonly toolCallId: string;
  readonly toolName: string;
  /** The turn that issued the call — used to group tool pills under a bubble. */
  readonly turnId: string;
  readonly status: TurnToolStatus;
  /** Short gateway-derived preview of the call's arguments. */
  readonly argsPreview: string;
  readonly startedAtMs: number;
  /** Present once the call reaches a terminal status. */
  readonly endedAtMs?: number;
  /** Present only for BACKGROUND tools (delegateTask). Joins to delegation.progress. */
  readonly taskId?: string;
}

export interface ToolStatusConnectorConfig {
  /** Called on every individual update. */
  onUpdate?: (item: ToolCallSnapshotItem) => void;
  /** Called whenever the list changes — ordered by startedAtMs ascending. */
  onList?: (items: readonly ToolCallSnapshotItem[]) => void;
}

// ---------------------------------------------------------------------------
// ToolStatusConnector — live per-tool-call status for the UI.
//
// Capability: "tool.status"
// Direction: status (observer; no outbound protocol from here)
//
// Receives: turn.tool.update (one on dispatch with status="running", one on
// settle with the terminal status; dedup by toolCallId so the row transitions
// in place). Terminal rows stay in the list — the UI filters if it wants only
// running calls.
//
// Replaces the retired TaskStatusConnector and its task-update dialect: the
// key is now toolCallId (every call has one) and taskId is optional
// (background tools only).
// ---------------------------------------------------------------------------

export class ToolStatusConnector implements Connector {
  readonly capability = "tool.status";
  readonly kind = "status" as const;

  private readonly config: ToolStatusConnectorConfig;
  private unsubs: (() => void)[] = [];
  private calls = new Map<string, ToolCallSnapshotItem>();

  constructor(config: ToolStatusConnectorConfig = {}) {
    this.config = config;
  }

  list(): readonly ToolCallSnapshotItem[] {
    return [...this.calls.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  attach(sdk: SentientSDKInternal): void {
    this.calls = new Map();

    this.unsubs.push(
      sdk.onMessage("turn.tool.update", (msg: unknown) => {
        const m = msg as {
          turnId?: string;
          toolCallId?: string;
          toolName?: string;
          status?: TurnToolStatus;
          taskId?: string;
          argsPreview?: string;
          startedAtMs?: number;
          endedAtMs?: number;
        };
        if (!m.turnId || !m.toolCallId || !m.toolName || !m.status || m.startedAtMs === undefined) {
          log.warn("tool-update-dropped", {
            reason: "missing required field on turn.tool.update",
            toolCallId: m.toolCallId ?? null,
            turnId: m.turnId ?? null,
          });
          return;
        }
        const item: ToolCallSnapshotItem = {
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          turnId: m.turnId,
          status: m.status,
          argsPreview: m.argsPreview ?? "",
          startedAtMs: m.startedAtMs,
          ...(m.endedAtMs !== undefined ? { endedAtMs: m.endedAtMs } : {}),
          ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
        };
        this.calls.set(item.toolCallId, item);
        log.debug("tool-update", {
          toolCallId: item.toolCallId,
          turnId: item.turnId,
          toolName: item.toolName,
          status: item.status,
        });
        this.config.onUpdate?.(item);
        this.config.onList?.(this.list());
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.calls = new Map();
  }
}
