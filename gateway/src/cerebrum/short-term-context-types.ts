export type Signal = "phasic" | "tonic";
export type EventClass = "user-direct" | "actionable" | "ambient" | "critical";
export type Urgency = "none" | "elevated" | "critical";

export interface ContextEvent {
  readonly seq: number;
  readonly ts: number;
  readonly kind: string;
  readonly source: string;
  readonly class: EventClass;
  readonly signal: Signal;
  readonly urgency: Urgency;
  readonly payload: unknown;
}

export type InjectableEvent = Omit<ContextEvent, "seq" | "ts">;

export interface TaskTableEntry {
  readonly taskId: string;
  readonly effectName: string;
  readonly status: "running" | "finished" | "cancelled" | "failed";
  readonly summary: string;
  readonly hasResult: boolean;
  readonly elapsedMs: number;
}

export interface Projection {
  readonly situationAwareness: SituationAwarenessTable;
  readonly salienceByEffect: Readonly<Record<string, number>>;
  readonly phasicEvents: readonly ContextEvent[];
  readonly tonicState: TonicState;
  readonly windowSeqRange: { readonly from: number; readonly to: number };
  /**
   * Running + recently completed tasks — the "sticky note in your back
   * pocket" surface. Rendered as a markdown table in the per-cycle system
   * message. Backed by TaskManager.snapshot(); window size is configured at
   * session wiring time.
   */
  readonly taskTable: ReadonlyArray<TaskTableEntry>;
  /**
   * Detailed results keyed by taskId for effects with providesContext=true.
   * Phase 1: empty (no context-producing effects yet). Reserved for
   * web_search, memory_recall, etc.
   */
  readonly resultsById: Readonly<Record<string, unknown>>;
}

export interface SituationAwarenessTable {
  readonly perceivedInputs: ReadonlyArray<{
    source: string;
    kind: string;
    summary: string;
    ts: number;
  }>;
  readonly tonicSummary: string;
  readonly comprehension: string;
}

export interface TonicState {
  readonly userPresence: "home" | "away" | "unknown";
  readonly lastInteractionAgeMs: number;
  readonly isTtsPlaying: boolean;
  /** Epoch ms of the first event ever injected into this session's context.
   *  Renders as a wall-clock string + duration so the LLM can answer
   *  "how long have we been talking" without arithmetic mistakes. */
  readonly sessionStartedAtMs: number;
  readonly runningEffects: ReadonlyArray<{
    name: string;
    elapsedMs: number;
    interruptable: boolean;
  }>;
  readonly [channel: string]: unknown;
}

export interface SalienceMap {
  lookup(kind: string): Readonly<Record<string, number>>;
}

export interface ShortTermContext {
  readonly sessionId: string;
  inject(event: InjectableEvent): number;
  project(opts?: { sinceSeq?: number }): Projection;
  latestSeq(): number;
  onInject(listener: (event: ContextEvent) => void): () => void;
}
