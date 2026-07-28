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
// CognitionStatusConnector — collapses turn + tool lifecycle into one
// UI-facing state.
//
// Capability: "cognition.status"
// Direction: status
//
// Receives (2.0 wire contract):
//   turn.started / turn.completed / turn.aborted   → active-turn membership
//   turn.tool.update                               → running-tool membership
//
// State function (pure, recomputed on every event):
//   no active turns                    → "idle"
//   active turns + a running tool call → "acting"
//   active turns, no running tool      → "thinking"
//
// MULTI-TURN (spec §7.2): membership is a SET of turnIds, not a single flag.
// A follow-up turn can start before the previous one completes; going idle on
// the first `turn.completed` would blank the UI while a turn is still running.
// ---------------------------------------------------------------------------

export class CognitionStatusConnector implements Connector {
  readonly capability = "cognition.status";
  readonly kind = "status" as const;

  private readonly config: CognitionStatusConfig;
  private unsubs: (() => void)[] = [];
  private currentState: CognitionState = "idle";
  /** Turns that have started and not yet completed or aborted. */
  private activeTurns = new Set<string>();
  /** turnId → toolCallIds still running for that turn. */
  private runningTools = new Map<string, Set<string>>();

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
    this.runningTools = new Map();

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
      sdk.onMessage("turn.tool.update", (msg: unknown) => {
        const m = msg as { turnId?: unknown; toolCallId?: unknown; status?: unknown };
        const turnId = readTurnId(msg);
        if (turnId === null || typeof m.toolCallId !== "string" || typeof m.status !== "string") return;
        const tools = this.runningTools.get(turnId) ?? new Set<string>();
        if (m.status === "running") tools.add(m.toolCallId);
        else tools.delete(m.toolCallId);
        this.runningTools.set(turnId, tools);
        this.recompute("turn.tool.update", turnId);
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.activeTurns = new Set();
    this.runningTools = new Map();
    this.currentState = "idle";
  }

  private endTurn(msg: unknown, trigger: string): void {
    const turnId = readTurnId(msg);
    if (turnId === null) return;
    this.activeTurns.delete(turnId);
    // Drop the turn's tool set outright. A BACKGROUND tool (delegateTask) can
    // still be running when its turn ends; keeping it here would pin cognition
    // at "acting" forever. Background work has its own surface —
    // DelegationProgressConnector.
    this.runningTools.delete(turnId);
    this.recompute(trigger, turnId);
  }

  private hasRunningTool(): boolean {
    for (const tools of this.runningTools.values()) {
      if (tools.size > 0) return true;
    }
    return false;
  }

  private computeState(): CognitionState {
    if (this.activeTurns.size === 0) return "idle";
    if (this.hasRunningTool()) return "acting";
    return "thinking";
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
