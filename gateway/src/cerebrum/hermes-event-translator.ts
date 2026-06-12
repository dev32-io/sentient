import { getLog } from "../logging/logger.js";
import { toFeedItem } from "./conversation-feed.js";
import type { ConversationMirror, MirrorEntry } from "./conversation-mirror.js";
import type { HermesEvent } from "./hermes-event-types.js";
import type { TaskMirror } from "./task-mirror.js";

const log = getLog(["sentient", "cerebrum", "hermes-event-translator"]);

// Watchdog interval — log a WARN if no Hermes event arrives within this
// window. Diagnostic only; never aborts the cycle (legitimate long tools
// can run far longer than this). Set conservatively so a brief LLM token
// gap doesn't trip it.
const CYCLE_GAP_WARN_MS = 5_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WireEmitter = (message: Record<string, unknown>) => void;

export interface TranslatorContext {
  sessionId: string;
  cycleId: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// Status mapping: Hermes tool finished status → TaskMirror status
// ---------------------------------------------------------------------------

const TOOL_STATUS_MAP = {
  ok: "finished" as const,
  failed: "failed" as const,
};

// ---------------------------------------------------------------------------
// Main translator
// ---------------------------------------------------------------------------

/**
 * Consumes a HermesEvent stream, mutates mirrors, and emits wire messages
 * for the client-facing WebSocket. Pure async consumer — no connection
 * lifecycle ownership.
 */
export async function translateHermesStream(
  events: AsyncIterable<HermesEvent>,
  context: TranslatorContext,
  mirror: ConversationMirror,
  tasks: TaskMirror,
  emit: WireEmitter,
  onConversationId: (id: string) => void,
): Promise<void> {
  const { sessionId, cycleId, userId } = context;
  const startedAtMs = Date.now();
  let assistantText = "";
  let sawError = false;
  let sawCompleted = false;
  let eventCount = 0;
  const effectsInvoked: string[] = [];

  log.info("start", { sessionId, cycleId, userId });

  emit({
    type: "cycle.started",
    cycleId,
    triggerKind: "conversation.user",
    triggerSource: userId,
  });

  // Per-cycle silence watchdog — diagnostic only, no abort. Resets on
  // every event arrival; if the gap exceeds CYCLE_GAP_WARN_MS the
  // recurring timer logs a WARN with the last event type so we can
  // tell whether the stall is post-tool-start, mid-text-stream, etc.
  //
  // Intentionally NOT folded into the session ActivityClock idle watchdog
  // (the cycle-abort control). This tracks HERMES-side silence only (resets on
  // Hermes events, not client WS traffic) — exactly the signal for diagnosing
  // where a cycle stalled. The ActivityClock, by contrast, stays warm on any
  // boundary (ws+acp) and owns the reap decision. Two different questions, two
  // signals; this one never aborts, so it is not a second control timer.
  let lastEventTs = startedAtMs;
  let lastEventType: HermesEvent["type"] | "<start>" = "<start>";
  const watchdog = setInterval(() => {
    const sinceLastMs = Date.now() - lastEventTs;
    if (sinceLastMs >= CYCLE_GAP_WARN_MS) {
      log.warn("cycle-gap", {
        sessionId,
        cycleId,
        sinceLastEventMs: sinceLastMs,
        lastEventType,
        eventCount,
      });
    }
  }, CYCLE_GAP_WARN_MS);

  try {
    for await (const ev of events) {
      eventCount++;
      lastEventTs = Date.now();
      lastEventType = ev.type;
      log.debug("event", { type: ev.type, cycleId, sessionId });
      handleEvent(ev, context, mirror, tasks, emit, onConversationId, {
        assistantTextRef: { value: assistantText },
        effectsInvoked,
        cycleStartedAtMs: startedAtMs,
        setAssistantText(v: string) {
          assistantText = v;
        },
        setSawError() {
          sawError = true;
        },
        setSawCompleted() {
          sawCompleted = true;
        },
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("iterator-threw", { sessionId, cycleId, reason: message, eventCount });
    sawError = true;
    emit({ type: "error", code: "hermes", message });
  } finally {
    clearInterval(watchdog);
  }

  if (sawError) {
    emit({ type: "cycle.aborted", cycleId, reason: "error" });
    if (assistantText.length > 0) {
      mirror.append({
        entryId: crypto.randomUUID(),
        kind: "assistant",
        ts: Date.now(),
        content: assistantText,
        cutoff: { kind: "interrupt", cancelledTaskIds: [] },
      });
      const lastEntry = mirror.snapshot()[mirror.size() - 1];
      if (lastEntry) emit({ type: "conversation.entry", cycleId, item: toFeedItem(lastEntry) });
    }
    tasks.clearCycle(cycleId);
    log.warn("aborted", {
      sessionId,
      cycleId,
      reason: "error in stream",
      partialAssistantChars: assistantText.length,
    });
  } else if (!sawCompleted) {
    // Stream ended without a terminal event — Hermes' adapter closed the
    // queue mid-flight (typically because the user-initiated cancel /
    // session-switch interrupt fired). Without this, the SDK's
    // InFlightMessageConnector never receives `cycle.aborted` and the
    // partial streaming bubble keeps rendering after the user has
    // switched to another session. Commits any partial assistant text
    // with an `interrupt` cutoff so the OLD session's history shows the
    // truncated turn on subsequent re-fetches.
    emit({ type: "cycle.aborted", cycleId, reason: "interrupt" });
    if (assistantText.length > 0) {
      mirror.append({
        entryId: crypto.randomUUID(),
        kind: "assistant",
        ts: Date.now(),
        content: assistantText,
        cutoff: { kind: "interrupt", cancelledTaskIds: [] },
      });
      const lastEntry = mirror.snapshot()[mirror.size() - 1];
      if (lastEntry) emit({ type: "conversation.entry", cycleId, item: toFeedItem(lastEntry) });
    }
    tasks.clearCycle(cycleId);
    log.info("aborted", {
      sessionId,
      cycleId,
      reason: "interrupt",
      partialAssistantChars: assistantText.length,
    });
  }

  log.info("done", {
    sessionId,
    cycleId,
    sawError,
    eventCount,
    assistantChars: assistantText.length,
    effectsInvoked: [...new Set(effectsInvoked)],
    elapsedMs: Date.now() - startedAtMs,
  });
}

// ---------------------------------------------------------------------------
// Event handler — one case per HermesEvent type
// ---------------------------------------------------------------------------

interface HandlerDeps {
  assistantTextRef: { value: string };
  effectsInvoked: string[];
  cycleStartedAtMs: number;
  setAssistantText(v: string): void;
  setSawError(): void;
  setSawCompleted(): void;
}

function handleEvent(
  ev: HermesEvent,
  ctx: TranslatorContext,
  mirror: ConversationMirror,
  tasks: TaskMirror,
  emit: WireEmitter,
  onConversationId: (id: string) => void,
  deps: HandlerDeps,
): void {
  switch (ev.type) {
    case "created":
      onConversationId(ev.conversationId);
      log.debug("conversation-bound", { conversationId: ev.conversationId, cycleId: ctx.cycleId });
      break;

    case "text.delta":
      deps.setAssistantText(deps.assistantTextRef.value + ev.delta);
      emit({ type: "message.delta", cycleId: ctx.cycleId, delta: ev.delta });
      break;

    case "tool.started":
      deps.effectsInvoked.push(ev.toolName);
      log.info("tool.started", {
        sessionId: ctx.sessionId,
        cycleId: ctx.cycleId,
        callId: ev.callId,
        toolName: ev.toolName,
        argsPreviewBytes: ev.argsPreview.length,
        elapsedFromCycleStartMs: Date.now() - deps.cycleStartedAtMs,
      });
      tasks.start({
        taskId: ev.callId,
        toolName: ev.toolName,
        cycleId: ctx.cycleId,
        argsPreview: ev.argsPreview,
      });
      emit({
        type: "task.update",
        taskId: ev.callId,
        toolName: ev.toolName,
        cycleId: ctx.cycleId,
        status: "running",
        argsPreview: ev.argsPreview,
        startedAtMs: Date.now(),
      });
      break;

    case "tool.args.delta":
      // No wire emit — args accumulated in HermesClient's inFlight tracker.
      break;

    case "tool.finished": {
      const taskStatus = TOOL_STATUS_MAP[ev.status];
      const rec = tasks.finish(ev.callId, taskStatus);
      const endedAtMs = rec?.endedAtMs ?? Date.now();
      log.info("tool.completed", {
        sessionId: ctx.sessionId,
        cycleId: ctx.cycleId,
        callId: ev.callId,
        toolName: rec?.toolName ?? "",
        status: taskStatus,
        summaryBytes: ev.summary.length,
        elapsedMs: rec ? endedAtMs - rec.startedAtMs : 0,
      });

      // Include startedAtMs on the finished update — the client's
      // TaskStatusConnector rejects task.update messages missing any
      // required field (incl. startedAtMs), which would leave the task
      // pill stuck in "running" state forever. Carry argsPreview through
      // too: the connector replaces the whole TaskSnapshotItem on each
      // update, so omitting argsPreview here would clobber the running
      // entry's preview to "" and leave the expanded pill empty after
      // completion.
      emit({
        type: "task.update",
        taskId: ev.callId,
        toolName: rec?.toolName ?? "",
        cycleId: ctx.cycleId,
        status: taskStatus,
        argsPreview: rec?.argsPreview ?? "",
        startedAtMs: rec?.startedAtMs ?? endedAtMs,
        endedAtMs,
      });

      if (rec) {
        const toolEntry: MirrorEntry = {
          entryId: crypto.randomUUID(),
          kind: "tool",
          ts: Date.now(),
          toolName: rec.toolName,
          status: taskStatus,
          summary: ev.summary,
        };
        mirror.append(toolEntry);
        emit({ type: "conversation.entry", cycleId: ctx.cycleId, item: toFeedItem(toolEntry) });
      }
      break;
    }

    case "completed": {
      deps.setSawCompleted();
      emit({ type: "message.done", cycleId: ctx.cycleId });

      if (deps.assistantTextRef.value.length > 0) {
        const assistantEntry: MirrorEntry = {
          entryId: crypto.randomUUID(),
          kind: "assistant",
          ts: Date.now(),
          content: deps.assistantTextRef.value,
        };
        mirror.append(assistantEntry);
        emit({ type: "conversation.entry", cycleId: ctx.cycleId, item: toFeedItem(assistantEntry) });
      }

      const dedupedEffects = [...new Set(deps.effectsInvoked)];
      emit({
        type: "cycle.completed",
        cycleId: ctx.cycleId,
        effectsInvoked: dedupedEffects,
      });
      break;
    }

    case "error":
      deps.setSawError();
      emit({ type: "error", code: "hermes", message: ev.message });
      break;
  }
}
