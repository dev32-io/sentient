import { getLog } from "../logging/logger.js";
import type { TtsChunk } from "../tts/stages/stage-types.js";
import type { ConversationMirror } from "./conversation-mirror.js";
import type { HermesClient, HermesProfileBinding } from "./hermes-client.js";
import { translateHermesStream } from "./hermes-event-translator.js";
import type { WireEmitter } from "./hermes-event-translator.js";
import type { DispatchMode, HermesTurnInput } from "./hermes-event-types.js";
import type { TaskMirror } from "./task-mirror.js";
import { forkTextDeltas } from "./text-delta-broadcaster.js";

const log = getLog(["sentient", "cerebrum", "hermes-dispatcher"]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TtsPipelineRun {
  done: Promise<void>;
  cancel(): void;
}

export interface HermesDispatcherDeps {
  clientFor(binding: HermesProfileBinding): HermesClient;
  mirror: ConversationMirror;
  tasks: TaskMirror;
  emit: WireEmitter;
  /** Phase 1.3+ — optional TTS pipeline starter. */
  startTts?: (deltas: AsyncIterable<TtsChunk>, cycleId: string) => TtsPipelineRun;
}

export interface HermesDispatchRequest {
  sessionId: string;
  userId: string;
  cycleId: string;
  userMessage: string;
  binding: HermesProfileBinding;
  maxOutputTokens: number;
  signal: AbortSignal;
  mode: DispatchMode;
  /** Gateway-minted session id to force on this cycle (consume-once). */
  forcedSessionId?: string;
}

// ---------------------------------------------------------------------------
// Dispatch shim
// ---------------------------------------------------------------------------

/**
 * Thin dispatch function that AttentionGate calls when cerebrum.provider=hermes.
 * Owns client instantiation, stream translation, conversationId capture, and
 * mirror updates. All heavy lifting is delegated to HermesClient and the
 * event translator.
 */
export async function dispatchHermesCycle(
  req: HermesDispatchRequest,
  deps: HermesDispatcherDeps,
): Promise<{ conversationId: string | null }> {
  const startedAtMs = Date.now();
  const client = deps.clientFor(req.binding);
  let capturedConversationId: string | null = req.binding.conversationId;

  log.info("dispatch.begin", {
    sessionId: req.sessionId,
    userId: req.userId,
    cycleId: req.cycleId,
    userMessagePreview: req.userMessage.length > 120 ? `${req.userMessage.slice(0, 120)}…` : req.userMessage,
    userMessageChars: req.userMessage.length,
    hasPreviousResponseId: req.binding.conversationId !== null,
    maxOutputTokens: req.maxOutputTokens,
    hasTtsBinding: deps.startTts !== undefined,
  });

  const input: HermesTurnInput = {
    userId: req.userId,
    cycleId: req.cycleId,
    userMessage: req.userMessage,
    conversationId: req.binding.conversationId,
    maxOutputTokens: req.maxOutputTokens,
    ...(req.forcedSessionId ? { forcedSessionId: req.forcedSessionId } : {}),
  };

  const rawEvents = client.dispatch(input, req.signal, req.mode);
  const { translatorEvents, textDeltas } = forkTextDeltas(rawEvents);

  const ttsRun = deps.startTts?.(textDeltas, req.cycleId);
  if (!deps.startTts) {
    log.debug("tts.absent.draining-deltas", { cycleId: req.cycleId });
    (async () => {
      for await (const _ of textDeltas) {
        /* drain to avoid blocking the broadcaster queue */
      }
    })();
  }

  await translateHermesStream(
    translatorEvents,
    { sessionId: req.sessionId, cycleId: req.cycleId, userId: req.userId },
    deps.mirror,
    deps.tasks,
    deps.emit,
    (id) => {
      capturedConversationId = id;
    },
  );

  if (ttsRun) {
    try {
      await ttsRun.done;
    } catch (err: unknown) {
      log.warn("tts.done.error", {
        cycleId: req.cycleId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("dispatch.end", {
    sessionId: req.sessionId,
    cycleId: req.cycleId,
    conversationId: capturedConversationId,
    conversationIdChanged: capturedConversationId !== req.binding.conversationId,
    aborted: req.signal.aborted,
    elapsedMs: Date.now() - startedAtMs,
  });

  return { conversationId: capturedConversationId };
}
