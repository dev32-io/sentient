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
  /** Short gateway-derived preview of the call's arguments. Empty on a tile
   *  built from the committed feed — that frame carries no arguments. */
  readonly argsPreview: string;
  /**
   * COMMITTED-FEED TILES ONLY — set by the client that rebuilds a tile from a
   * `kind:"tool"` conversation item, never by this connector.
   *
   * The two tile sources carry opposite halves of the round trip: the live
   * `turn.tool.update` frame has the call's ARGUMENTS and never its result,
   * while a committed feed item has the RESULT (`summary`) and never the
   * arguments. A tile therefore fills in whichever half it was built from, and
   * the UI must render them as the different things they are.
   */
  readonly resultPreview?: string;
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
//
// CACHE LIFETIME — attach/detach are TRANSPORT lifecycle, not session
// lifecycle, so neither touches the call map. A reconnect detaches every
// connector (sdk-close-handler.teardownWsForReconnect) and re-attaches them on
// the next session.ready; the normal `recovered:true` resume then replays ONLY
// the frames the client missed. Clearing here dropped every tile the client had
// already seen — the gateway never re-sends those — and left the tool strip
// desynced from the committed mirror, which survives the same reconnect
// (ConversationHistoryConnector). webui's cycle-helpers joins the two sources
// per turn by dispatch position, so a truncated live list is not merely missing
// tiles: it makes a still-running call unrenderable until it commits.
//
// `reset()` is the session/identity teardown path (SentientSDK.disconnect) and
// the only clear. A reconnect must never reach it.
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

  /** Drop the socket subscriptions only. The call cache survives — see CACHE
   *  LIFETIME above. */
  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /** Drop all session state. `SentientSDK.disconnect()` is the one caller. */
  reset(): void {
    const previousCount = this.calls.size;
    this.calls = new Map();
    log.info("tool-status.reset", { reason: "session identity teardown", previousCount });
  }
}
