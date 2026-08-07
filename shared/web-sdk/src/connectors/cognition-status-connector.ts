import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "cognition-status"]);

export type CognitionState = "idle" | "thinking" | "acting";

export interface CognitionStatusConfig {
  /** Called when the cognition state changes. Never fires on a no-op transition. */
  onStateChange?: (state: CognitionState) => void;
}

/** Reads a non-empty `turnId` off an untyped frame. */
function readTurnId(msg: unknown): string | null {
  const m = msg as { turnId?: unknown };
  return typeof m.turnId === "string" && m.turnId.length > 0 ? m.turnId : null;
}

// ---------------------------------------------------------------------------
// CognitionStatusConnector — collapses turn + tool lifecycle into one UI-facing
// state.
//
// Capability: "cognition.status"
// Direction: status
//
// Receives (2.0 wire contract):
//   turn.started / turn.completed / turn.aborted   → active-turn membership
//   tasklist.state                                 → is a FOREGROUND row running
//
// State function (pure, recomputed on every event):
//   no active turns                         → "idle"
//   active turns + a running foreground row → "acting"
//   active turns, no running foreground row → "thinking"
//
// THE STRIP IS A STRICTLY BETTER SOURCE THAN THE RETIRED PER-CALL FRAME, and
// `kind` is why. That frame carried no foreground/background discriminator, so
// this connector could not tell a tool the turn is BLOCKED ON from a
// `delegateTask` handed off to run for minutes — it had to drop the whole
// turn's tool set on `turn.completed` just to stop a background dispatch
// pinning cognition at "acting" forever. `tasklist.state` carries
// `kind: "foreground" | "background"` on every row, so the question is answered
// directly: only a FOREGROUND row means the loop is waiting on a tool. A
// background row is someone else's work and belongs to DelegationProgressConnector.
//
// FULL STATE, LAST-ONE-WINS. Every `tasklist.state` replaces the row list
// outright (the gateway owns row lifetime — runtime/task-list.ts), so there is
// no merge, no per-turn bookkeeping, and no lifetime rule on this side. That is
// also why the turn gate below is belt-and-braces rather than load-bearing:
// foreground rows die with their turn at the source.
//
// MULTI-TURN (spec §7.2): membership is a SET of turnIds, not a single flag.
// A follow-up turn can start before the previous one completes; going idle on
// the first `turn.completed` would blank the UI while a turn is still running.
// ---------------------------------------------------------------------------

/** One `tasklist.state` row, narrowed to the two fields this connector reads.
 *  Deliberately structural rather than the protocol's `TaskListItem`: frames
 *  arrive here untyped, and this connector must survive a row missing either
 *  field without throwing. */
interface TaskRowShape {
  kind?: unknown;
  status?: unknown;
}

const FOREGROUND = "foreground";
const RUNNING = "running";

export class CognitionStatusConnector implements Connector {
  readonly capability = "cognition.status";
  readonly kind = "status" as const;

  private readonly config: CognitionStatusConfig;
  private unsubs: (() => void)[] = [];
  private currentState: CognitionState = "idle";
  /** Turns that have started and not yet completed or aborted. */
  private activeTurns = new Set<string>();
  /** Whether the LAST `tasklist.state` carried a running foreground row. Full
   *  state, so one boolean is the whole memory — no per-turn map to reconcile. */
  private hasRunningForegroundTool = false;

  constructor(config: CognitionStatusConfig = {}) {
    this.config = config;
  }

  /** Current cognition state. */
  state(): CognitionState {
    return this.currentState;
  }

  attach(sdk: SentientSDKInternal): void {
    this.currentState = "idle";
    this.activeTurns = new Set();
    this.hasRunningForegroundTool = false;

    this.unsubs.push(
      sdk.onMessage("turn.started", (msg: unknown) => {
        const turnId = readTurnId(msg);
        if (turnId === null) return;
        this.activeTurns.add(turnId);
        this.recompute("turn.started", turnId);
      }),
    );

    this.unsubs.push(sdk.onMessage("turn.completed", (msg: unknown) => this.endTurn(msg, "turn.completed")));
    this.unsubs.push(sdk.onMessage("turn.aborted", (msg: unknown) => this.endTurn(msg, "turn.aborted")));

    this.unsubs.push(
      sdk.onMessage("tasklist.state", (msg: unknown) => {
        const m = msg as { items?: unknown };
        const rows: readonly TaskRowShape[] = Array.isArray(m.items) ? m.items : [];
        // A BACKGROUND row never counts: `delegateTask` is fire-and-steer, so
        // the loop is not waiting on it and the turn it was dispatched from
        // finishes without it. Counting one would pin "acting" for as long as
        // the task lives.
        this.hasRunningForegroundTool = rows.some((r) => r.kind === FOREGROUND && r.status === RUNNING);
        // `turnId` is nullable on this frame (background-only rows outliving
        // their turn), so it is NOT the recompute key — active-turn membership
        // comes from the `turn.*` family alone.
        this.recompute("tasklist.state", readTurnId(msg) ?? "");
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.activeTurns = new Set();
    this.hasRunningForegroundTool = false;
    this.currentState = "idle";
  }

  private endTurn(msg: unknown, trigger: string): void {
    const turnId = readTurnId(msg);
    if (turnId === null) return;
    this.activeTurns.delete(turnId);
    this.recompute(trigger, turnId);
  }

  private computeState(): CognitionState {
    if (this.activeTurns.size === 0) return "idle";
    return this.hasRunningForegroundTool ? "acting" : "thinking";
  }

  private recompute(trigger: string, turnId: string): void {
    const next = this.computeState();
    if (next === this.currentState) return;
    log.debug("state-change", {
      from: this.currentState,
      to: next,
      trigger,
      turnId,
      activeTurns: this.activeTurns.size,
    });
    this.currentState = next;
    this.config.onStateChange?.(next);
  }
}
