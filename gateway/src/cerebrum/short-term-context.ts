import { getLog } from "../logging/logger.js";
import type { ConversationMirror } from "./conversation-mirror.js";
import type {
  ContextEvent,
  InjectableEvent,
  Projection,
  SalienceMap,
  ShortTermContext,
  SituationAwarenessTable,
  TaskTableEntry,
  TonicState,
} from "./short-term-context-types.js";
import type { TaskMirror } from "./task-mirror.js";

const log = getLog(["sentient", "cerebrum", "short-term-context"]);

const DEFAULT_TASK_TABLE_WINDOW = 30;

export interface ShortTermContextDeps {
  /** Binds TaskMirror so projection can populate the task table. */
  readonly taskMirror?: TaskMirror;
  /** How many recently-completed tasks to include in taskTable. */
  readonly taskTableWindow?: number;
  /**
   * When provided, `buildTonicState` scans the most recent user/trigger entry
   * to compute `lastInteractionAgeMs`.
   */
  readonly conversationHistory?: ConversationMirror;
}

type InjectListener = (event: ContextEvent) => void;

function summarizeEvent(event: ContextEvent): string {
  const payload = event.payload as Record<string, unknown> | null;
  if (payload && typeof payload.text === "string") {
    return payload.text;
  }
  return event.kind;
}

function buildSituationAwareness(phasicEvents: readonly ContextEvent[]): SituationAwarenessTable {
  const perceivedInputs = phasicEvents.map((e) => ({
    source: e.source,
    kind: e.kind,
    summary: summarizeEvent(e),
    ts: e.ts,
  }));

  return {
    perceivedInputs,
    tonicSummary: "",
    comprehension: "",
  };
}

function latestUserInteractionTs(
  conversationHistory: ConversationMirror | undefined,
  events: readonly ContextEvent[],
): number {
  if (conversationHistory) {
    const entries = conversationHistory.snapshot();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && (entry.kind === "user" || entry.kind === "trigger")) {
        return entry.ts;
      }
    }
    return 0;
  }
  // Backward-compatible fallback for tests that don't inject conversationHistory.
  let ts = 0;
  for (const e of events) {
    if (e.class === "user-direct") {
      ts = Math.max(ts, e.ts);
    }
  }
  return ts;
}

function buildTonicState(
  events: readonly ContextEvent[],
  taskMirror: TaskMirror | undefined,
  sessionStartedAtMs: number,
  conversationHistory: ConversationMirror | undefined,
): TonicState {
  const lastInteractionTs = latestUserInteractionTs(conversationHistory, events);
  const lastInteractionAgeMs = lastInteractionTs > 0 ? Date.now() - lastInteractionTs : 0;
  const runningEffects = taskMirror
    ? taskMirror
        .snapshot()
        .filter((r) => r.status === "running")
        .map((r) => ({
          name: r.toolName,
          elapsedMs: Date.now() - r.startedAtMs,
          interruptable: true,
        }))
    : [];

  return {
    userPresence: "unknown",
    lastInteractionAgeMs,
    isTtsPlaying: false,
    sessionStartedAtMs,
    runningEffects,
  };
}

function buildTaskTable(taskMirror: TaskMirror | undefined, window: number): ReadonlyArray<TaskTableEntry> {
  if (!taskMirror) return [];
  const all = taskMirror.snapshot();
  // Most recent `window` entries, newest first.
  const sliced = all.slice(-window).reverse();
  return sliced.map((r) => ({
    taskId: r.taskId,
    effectName: r.toolName,
    status: r.status,
    summary: r.argsPreview,
    hasResult: r.status === "finished",
    elapsedMs: r.endedAtMs !== undefined ? r.endedAtMs - r.startedAtMs : Date.now() - r.startedAtMs,
  }));
}

function computeSalience(events: readonly ContextEvent[], salienceMap: SalienceMap): Readonly<Record<string, number>> {
  const salience: Record<string, number> = {};

  for (const event of events) {
    const effects = salienceMap.lookup(event.kind);
    for (const [effect, weight] of Object.entries(effects)) {
      salience[effect] = (salience[effect] ?? 0) + weight;
    }
  }

  return salience;
}

export function createShortTermContext(
  sessionId: string,
  salienceMap: SalienceMap,
  deps: ShortTermContextDeps = {},
): ShortTermContext {
  const events: ContextEvent[] = [];
  const listeners: Set<InjectListener> = new Set();
  let nextSeq = 1;
  const taskMirror = deps.taskMirror;
  const taskTableWindow = deps.taskTableWindow ?? DEFAULT_TASK_TABLE_WINDOW;
  const conversationHistory = deps.conversationHistory;
  // Pinned at construction so "session age" is the age of the CONVERSATION,
  // not of the oldest surviving event after history truncation.
  const sessionStartedAtMs = Date.now();

  function injectInternal(injectable: InjectableEvent): number {
    const seq = nextSeq++;
    const event: ContextEvent = {
      seq,
      ts: Date.now(),
      kind: injectable.kind,
      source: injectable.source,
      class: injectable.class,
      signal: injectable.signal,
      urgency: injectable.urgency,
      payload: injectable.payload,
    };

    events.push(event);

    log.debug("inject", {
      seq,
      kind: event.kind,
      source: event.source,
      sessionId,
    });

    for (const listener of listeners) {
      listener(event);
    }

    return seq;
  }

  function project(opts?: { sinceSeq?: number }): Projection {
    const sinceSeq = opts?.sinceSeq ?? 0;
    const windowEvents = events.filter((e) => e.seq > sinceSeq);
    const phasicEvents = windowEvents.filter((e) => e.signal === "phasic");
    const salienceByEffect = computeSalience(phasicEvents, salienceMap);
    const situationAwareness = buildSituationAwareness(phasicEvents);
    const tonicState = buildTonicState(events, taskMirror, sessionStartedAtMs, conversationHistory);
    const taskTable = buildTaskTable(taskMirror, taskTableWindow);
    const lastEvent = events[events.length - 1];
    const latestSeqValue = lastEvent?.seq ?? 0;

    log.debug("project", {
      sinceSeq,
      eventCount: windowEvents.length,
      phasicCount: phasicEvents.length,
      salienceByEffect,
      taskTableSize: taskTable.length,
      sessionId,
    });

    return {
      situationAwareness,
      salienceByEffect,
      phasicEvents,
      tonicState,
      taskTable,
      resultsById: {},
      windowSeqRange: { from: sinceSeq, to: latestSeqValue },
    };
  }

  return {
    sessionId,

    inject(event: InjectableEvent): number {
      return injectInternal(event);
    },

    project,

    latestSeq(): number {
      const lastEvent = events[events.length - 1];
      return lastEvent?.seq ?? 0;
    },

    onInject(listener: InjectListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
