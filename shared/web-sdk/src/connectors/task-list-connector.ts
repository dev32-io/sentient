import type { TaskListItem } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "task-list"]);

export interface TaskListConnectorConfig {
  /** Called on every `tasklist.state` frame, and on reset(). */
  onUpdate?: (turnId: string | null, items: readonly TaskListItem[]) => void;
}

// ---------------------------------------------------------------------------
// TaskListConnector — the composer task strip's mirror.
//
// Capability: "tasklist"
// Direction: status (observer; no outbound protocol from here)
//
// Holds whatever the last `tasklist.state` frame said and nothing else. The
// gateway sends FULL STATE every time (runtime/task-list.ts owns which rows
// exist and how long each lives), so there is no merge, no dedupe, and no
// lifetime rule on this side. Replacing the whole list is the entire contract:
// a replayed frame, a fan-out to a second window, and a late joiner's attach
// are the same operation.
//
// Replaces the retired ToolStatusConnector for new consumers (ToolStatusConnector
// itself stays in place until the webui migrates off it), which held tool
// calls forever and left every consumer deriving which bubble a pill belonged
// to.
// ---------------------------------------------------------------------------

export class TaskListConnector implements Connector {
  readonly capability = "tasklist";
  readonly kind = "status" as const;

  private readonly config: TaskListConnectorConfig;
  private unsubs: (() => void)[] = [];
  private items: readonly TaskListItem[] = [];
  private turn: string | null = null;

  constructor(config: TaskListConnectorConfig = {}) {
    this.config = config;
  }

  list(): readonly TaskListItem[] {
    return this.items;
  }

  turnId(): string | null {
    return this.turn;
  }

  attach(sdk: SentientSDKInternal): void {
    this.unsubs.push(
      sdk.onMessage("tasklist.state", (msg: unknown) => {
        const m = msg as { turnId?: string | null; items?: TaskListItem[] };
        this.items = Array.isArray(m.items) ? m.items : [];
        this.turn = m.turnId ?? null;
        // Row COUNT only — argsPreview is user content and never logged.
        log.debug("tasklist.state", { turnId: this.turn, count: this.items.length });
        this.config.onUpdate?.(this.turn, this.items);
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /** Drop everything. Called on disconnect, same as every other mirror. */
  reset(): void {
    const previousCount = this.items.length;
    this.items = [];
    this.turn = null;
    log.info("task-list.reset", { reason: "session identity teardown", previousCount });
    this.config.onUpdate?.(null, this.items);
  }
}
