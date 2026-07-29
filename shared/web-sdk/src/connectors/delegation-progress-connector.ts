import type { DelegationStatus } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "delegation-progress"]);

export interface DelegationProgressItem {
  /** Handle returned by the background tool. Dedup key. */
  readonly taskId: string;
  /** The turn that dispatched the delegation. */
  readonly turnId: string;
  /** Worker the task was delegated to (e.g. "hermes"). */
  readonly agent: string;
  readonly status: DelegationStatus;
  /** Optional short progress note from the worker. */
  readonly note?: string;
}

export interface DelegationProgressConnectorConfig {
  /** Called on every individual update. */
  onUpdate?: (item: DelegationProgressItem) => void;
  /** Called whenever the list changes — insertion order (dispatch order). */
  onList?: (items: readonly DelegationProgressItem[]) => void;
}

// ---------------------------------------------------------------------------
// DelegationProgressConnector — live status of BACKGROUND delegated work
// (spec §5.4 / §7).
//
// Capability: "delegation.progress"
// Direction: status (observer)
//
// Receives: delegation.progress — one frame per status transition of a
// `delegateTask` background task; dedup by taskId so a row transitions in
// place. The frame carries no timestamp, so ordering is insertion (dispatch)
// order. Terminal rows stay in the list; the UI filters if it wants only
// running work.
//
// Join key: `ToolCallSnapshotItem.taskId` (from turn.tool.update) is the same
// id, so the UI can attach progress to the tool pill that launched it.
//
// CACHE LIFETIME — attach/detach are TRANSPORT lifecycle, not session
// lifecycle, so neither touches the task map. Same rule, same reason, as
// ToolStatusConnector's own CACHE LIFETIME header and
// ConversationHistoryConnector's mirror: a reconnect detaches every connector
// (sdk-close-handler.teardownWsForReconnect) and re-attaches them on the next
// session.ready, and the `recovered:true` resume then replays ONLY the frames
// the client missed. Clearing here dropped every row the client had already
// seen, and the gateway never re-sends those.
//
// The stakes are higher on this connector than on the live tool cache.
// Delegated work is the longest-lived thing on this wire — `delegateTask` is
// fire-and-steer, so a Hermes task routinely outlives the socket that
// dispatched it and reports its completion on a LATER turn. Wiping the map on
// reconnect stranded exactly that work: its `running` row vanished, and the
// only frame that could have restored it was the terminal one, arriving
// minutes later, if at all.
//
// `reset()` is the session/identity teardown path (SentientSDK.disconnect) and
// the only clear. A reconnect must never reach it.
// ---------------------------------------------------------------------------

export class DelegationProgressConnector implements Connector {
  readonly capability = "delegation.progress";
  readonly kind = "status" as const;

  private readonly config: DelegationProgressConnectorConfig;
  private unsubs: (() => void)[] = [];
  private tasks = new Map<string, DelegationProgressItem>();

  constructor(config: DelegationProgressConnectorConfig = {}) {
    this.config = config;
  }

  /** Every delegated task seen this session, in dispatch order. */
  list(): readonly DelegationProgressItem[] {
    return [...this.tasks.values()];
  }

  attach(sdk: SentientSDKInternal): void {
    this.unsubs.push(
      sdk.onMessage("delegation.progress", (msg: unknown) => {
        const m = msg as {
          taskId?: string;
          turnId?: string;
          agent?: string;
          status?: DelegationStatus;
          note?: string;
        };
        if (!m.taskId || !m.turnId || !m.agent || !m.status) {
          log.warn("delegation-progress-dropped", {
            reason: "missing required field on delegation.progress",
            taskId: m.taskId ?? null,
          });
          return;
        }
        const item: DelegationProgressItem = {
          taskId: m.taskId,
          turnId: m.turnId,
          agent: m.agent,
          status: m.status,
          ...(m.note !== undefined ? { note: m.note } : {}),
        };
        this.tasks.set(item.taskId, item);
        log.info("delegation-progress", {
          taskId: item.taskId,
          turnId: item.turnId,
          agent: item.agent,
          status: item.status,
        });
        this.config.onUpdate?.(item);
        this.config.onList?.(this.list());
      }),
    );
  }

  /** Drop the socket subscriptions only. The task map survives — see CACHE
   *  LIFETIME above. */
  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /** Drop all session state. `SentientSDK.disconnect()` is the one caller. */
  reset(): void {
    const previousCount = this.tasks.size;
    this.tasks = new Map();
    log.info("delegation-progress.reset", { reason: "session identity teardown", previousCount });
  }
}
