import { getLog } from "../logging/logger.js";
import {
  accumulateSalience,
  findExceedingEffect,
  mergeSalience,
  salienceKeyForInjectEvent,
  salienceKeyForMirrorEntry,
} from "./attention-gate-salience.js";
import type { ConversationMirror, MirrorEntry } from "./conversation-mirror.js";
import type { ContextEvent, SalienceMap, ShortTermContext } from "./short-term-context-types.js";

const log = getLog(["sentient", "cerebrum", "attention-gate"]);

const ONE_HOUR_MS = 3_600_000;

export interface AttentionGateConfig {
  debounceWindowMs: number;
  standardThreshold: number;
  immediateWakeThreshold: number;
  maxPerHour: number;
  /**
   * ReAct loop safety cap. Maximum number of consecutive auto-triggered
   * continuation cycles between two external stimuli. When a cycle at
   * position `maxIterations - 1` of the chain reports `shouldContinue`,
   * the gate dispatches one more cycle with `forceFinal=true` (the model
   * is forced to produce a content-only closing reply, no tools) and then
   * the chain terminates.
   */
  maxIterations: number;
  /**
   * How many cycles before the max cap the ReAct-budget warning should be
   * injected into ConversationMirror as a trigger entry. The model sees
   * the warning in its transcript but AttentionGate does NOT wake on it.
   * Default: 3.
   */
  maxIterWarnAhead: number;
}

export interface AttentionGateCallbacks {
  onCycle: (params: {
    cycleId: string;
    sinceSeq: number;
    triggerReason: string;
    forceFinal: boolean;
  }) => Promise<CycleOutcome>;
}

/**
 * What `onCycle` reports back.
 */
export interface CycleOutcome {
  readonly aborted: boolean;
  readonly shouldContinue: boolean;
}

/**
 * Creates the attention gate.
 *
 * Subscribes to ShortTermContext inject events and ConversationMirror
 * appends, evaluates salience with debounce, fires dispatch cycles when
 * threshold crossed, and runs the ReAct continuation loop when a cycle's
 * completed effects ask to retrigger.
 *
 * Barge-in and interrupt live OUTSIDE the gate — they're direct
 * session-level signals that reach the cycle AbortController
 * without going through salience. The gate doesn't know or care.
 *
 * Three dispatch paths:
 *   - Debounce path: external stimulus, salience >= standardThreshold
 *   - Immediate wake: external stimulus, salience >= immediateWakeThreshold
 *   - ReAct continuation: cycle just ended with `shouldContinue=true`
 *     (no debounce, no salience threshold, bounded by maxIterations)
 *
 * Wake sources:
 *   - conversationMirror.onAppend: user/trigger entries -> external stimulus
 *     (assistant/tool entries are self-output and do NOT wake the gate)
 *   - ctx.onInject: ambient/sensor STC events -> external stimulus
 *     (user events never arrive via STC inject; they go through mirror only)
 *
 * Salience is accumulated locally in two per-source accumulators
 * (`conversationSalience` and `ambientSalience`) on every external stimulus.
 * Threshold checks operate on their merged sum. Both reset when a cycle is
 * dispatched. Deferred bumps captured during an active cycle remain and
 * re-evaluate at cycle end. `clearPendingConversationSalience()` zeroes only
 * the conversation accumulator, leaving ambient signals intact.
 */
export interface AttentionGateHandle {
  dispose(): void;
  /**
   * Drop any accumulated conversation-sourced salience since the last cycle
   * end. Called from InterruptController on user interrupt to cancel the
   * queued-conversation-signal backlog. Does not affect ambient salience.
   */
  clearPendingConversationSalience(): void;
  /**
   * Alias for `clearPendingConversationSalience()`. Called by the wiring
   * layer after a session switch so the new chain doesn't fire an immediate
   * cycle on stale conversation salience. Ambient salience is preserved per
   * `.claude/rules/architecture.md`.
   */
  clearConversationSalience(): void;
}

export function createAttentionGate(
  ctx: ShortTermContext,
  config: AttentionGateConfig,
  callbacks: AttentionGateCallbacks,
  conversationMirror: ConversationMirror,
  salienceMap: SalienceMap,
): AttentionGateHandle {
  let lastCycleEndSeq = 0;
  let activeCyclePromise: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSalience = false;
  const cycleTimestamps: number[] = [];
  let cycleCounter = 0;
  let disposed = false;

  // Salience accumulators, split by source so interrupt can clear only
  // conversation-originated pending signals while preserving ambient ones.
  let conversationSalience: Record<string, number> = {};
  let ambientSalience: Record<string, number> = {};

  // Whether the ReAct-budget warning has been injected into
  // ConversationMirror for the current chain. Reset in resetChain.
  let warningInjectedInChain = false;

  // ReAct chain state.
  let chainLength = 0;

  function generateCycleId(): string {
    cycleCounter++;
    return `cycle-${cycleCounter}`;
  }

  function isRateLimited(): boolean {
    const cutoff = Date.now() - ONE_HOUR_MS;
    pruneCycleTimestamps(cutoff);
    const isLimited = cycleTimestamps.length >= config.maxPerHour;
    if (isLimited) {
      log.warn("rate limit hit", {
        cyclesInWindow: cycleTimestamps.length,
        maxPerHour: config.maxPerHour,
        sessionId: ctx.sessionId,
      });
    }
    return isLimited;
  }

  function pruneCycleTimestamps(cutoff: number): void {
    while (cycleTimestamps.length > 0 && (cycleTimestamps[0] ?? 0) < cutoff) {
      cycleTimestamps.shift();
    }
  }

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function resetChain(reason: string): void {
    if (chainLength !== 0 || warningInjectedInChain) {
      log.debug("chain reset", {
        reason,
        priorChainLength: chainLength,
        sessionId: ctx.sessionId,
      });
      chainLength = 0;
      warningInjectedInChain = false;
    }
  }

  function evaluateAndFireCycle(reason: string): void {
    if (disposed) return;

    const merged = mergeSalience(conversationSalience, ambientSalience);
    log.debug("threshold evaluation", {
      conversationSalience,
      ambientSalience,
      merged,
      sinceSeq: lastCycleEndSeq,
      reason,
      sessionId: ctx.sessionId,
    });

    const exceeds = findExceedingEffect(merged, config.standardThreshold);
    if (exceeds === null) return;

    dispatchCycle(`debounce: ${exceeds}`, false);
  }

  function dispatchCycle(triggerReason: string, forceFinal: boolean): void {
    if (activeCyclePromise !== null) {
      pendingSalience = true;
      log.debug("dispatch deferred — cycle active", {
        triggerReason,
        forceFinal,
        sessionId: ctx.sessionId,
      });
      return;
    }
    if (isRateLimited()) return;

    const cycleId = generateCycleId();
    const sinceSeq = lastCycleEndSeq;
    const cycleEndSeq = ctx.latestSeq();

    const snapshotConversation = conversationSalience;
    const snapshotAmbient = ambientSalience;
    conversationSalience = {};
    ambientSalience = {};

    log.info("cycle dispatched", {
      cycleId,
      sinceSeq,
      triggerReason,
      forceFinal,
      chainLength,
      snapshotConversation,
      snapshotAmbient,
      sessionId: ctx.sessionId,
    });

    cycleTimestamps.push(Date.now());
    lastCycleEndSeq = cycleEndSeq;

    activeCyclePromise = callbacks
      .onCycle({ cycleId, sinceSeq, triggerReason, forceFinal })
      .then((outcome) => onCycleComplete(cycleId, outcome))
      .catch((err: unknown) => {
        log.warn("cycle rejected", {
          cycleId,
          error: err instanceof Error ? err.message : String(err),
          sessionId: ctx.sessionId,
        });
        onCycleComplete(cycleId, { aborted: true, shouldContinue: false });
      });
  }

  function onCycleComplete(cycleId: string, outcome: CycleOutcome): void {
    activeCyclePromise = null;

    if (disposed) return;

    if (outcome.aborted) {
      log.debug("cycle complete — aborted", {
        cycleId,
        chainLength,
        sessionId: ctx.sessionId,
      });
      resetChain("aborted");
      maybeHandlePendingSalience();
      return;
    }

    if (outcome.shouldContinue) {
      const nextChainLength = chainLength + 1;
      const totalAfterDispatch = nextChainLength + 1;

      // Inject ReAct-budget warning into ConversationMirror.
      if (!warningInjectedInChain && totalAfterDispatch + config.maxIterWarnAhead > config.maxIterations) {
        const remaining = config.maxIterations - totalAfterDispatch + 1;
        conversationMirror.append({
          entryId: crypto.randomUUID(),
          kind: "trigger",
          ts: Date.now(),
          source: "react-budget",
          summary: `System notice: ${remaining} tool-call cycle${remaining === 1 ? "" : "s"} remain before budget closes. Wrap up your reply; after that you'll be limited to a content-only response with no tool calls.`,
        });
        warningInjectedInChain = true;
        log.info("react-budget-warning-injected", {
          cycleId,
          remaining,
          chainLength,
          sessionId: ctx.sessionId,
        });
      }

      if (totalAfterDispatch < config.maxIterations) {
        chainLength = nextChainLength;
        log.info("chain continue", {
          priorCycleId: cycleId,
          chainLength,
          totalCyclesInChain: totalAfterDispatch,
          maxIterations: config.maxIterations,
          sessionId: ctx.sessionId,
        });
        dispatchCycle(`react-continuation (cycle ${totalAfterDispatch}/${config.maxIterations})`, false);
        return;
      }
      chainLength = nextChainLength;
      log.warn("chain cap — force final", {
        priorCycleId: cycleId,
        chainLength,
        totalCyclesInChain: totalAfterDispatch,
        maxIterations: config.maxIterations,
        sessionId: ctx.sessionId,
      });
      dispatchCycle(`react-force-final (cycle ${totalAfterDispatch}/${config.maxIterations})`, true);
      return;
    }

    log.debug("chain end", {
      cycleId,
      chainLength,
      sessionId: ctx.sessionId,
    });
    resetChain("natural-end");
    maybeHandlePendingSalience();
  }

  function maybeHandlePendingSalience(): void {
    if (!pendingSalience || disposed) return;
    pendingSalience = false;
    checkPendingSalience();
  }

  function checkPendingSalience(): void {
    const merged = mergeSalience(conversationSalience, ambientSalience);
    const exceeds = findExceedingEffect(merged, config.standardThreshold);
    log.debug("pending-salience-check", {
      conversationSalience,
      ambientSalience,
      merged,
      exceeds,
      sessionId: ctx.sessionId,
    });
    if (exceeds !== null) {
      dispatchCycle(`pending: ${exceeds}`, false);
    }
  }

  function handleExternalStimulus(source: string): void {
    resetChain("external-stimulus");

    if (activeCyclePromise === null) {
      const merged = mergeSalience(conversationSalience, ambientSalience);
      const exceeds = findExceedingEffect(merged, config.immediateWakeThreshold);
      if (exceeds !== null) {
        clearDebounce();
        log.debug("immediate wake from external stimulus", {
          source,
          exceeds,
          sessionId: ctx.sessionId,
        });
        dispatchCycle(`immediate: ${exceeds}`, false);
        return;
      }
    }

    if (activeCyclePromise !== null) {
      pendingSalience = true;
      log.debug("accumulating during active cycle", {
        source,
        sessionId: ctx.sessionId,
      });
      return;
    }

    startOrExtendDebounce();
  }

  function handleInject(event: ContextEvent): void {
    if (disposed) return;

    const salienceKey = salienceKeyForInjectEvent(event);
    if (salienceKey === null) {
      return;
    }

    log.debug("stc inject external stimulus", {
      seq: event.seq,
      kind: event.kind,
      class: event.class,
      salienceKey,
      sessionId: ctx.sessionId,
    });

    accumulateSalience(ambientSalience, salienceKey, salienceMap, {
      source: `stc:${event.kind}`,
      sessionId: ctx.sessionId,
    });

    handleExternalStimulus(`stc:${event.kind}`);
  }

  function handleMirrorAppend(entry: MirrorEntry): void {
    if (disposed) return;

    // Self-output entries do not wake the gate.
    if (entry.kind === "assistant" || entry.kind === "tool") {
      log.debug("mirror append skipped — self-output", {
        entryKind: entry.kind,
        sessionId: ctx.sessionId,
      });
      return;
    }

    const salienceKey = salienceKeyForMirrorEntry(entry);
    if (salienceKey === null) {
      log.warn("mirror-append-no-salience-key", {
        reason: "no salience key mapped for entry kind",
        entryKind: entry.kind,
        sessionId: ctx.sessionId,
      });
      return;
    }

    log.debug("mirror append external stimulus", {
      entryKind: entry.kind,
      salienceKey,
      sessionId: ctx.sessionId,
    });

    accumulateSalience(conversationSalience, salienceKey, salienceMap, {
      source: `mirror:${entry.kind}`,
      sessionId: ctx.sessionId,
    });

    handleExternalStimulus(`mirror:${entry.kind}`);
  }

  function startOrExtendDebounce(): void {
    const isExtend = debounceTimer !== null;
    clearDebounce();

    log.debug(isExtend ? "debounce extended" : "debounce opened", {
      windowMs: config.debounceWindowMs,
      sessionId: ctx.sessionId,
    });

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      evaluateAndFireCycle("debounce_close");
    }, config.debounceWindowMs);
  }

  const unsubscribeCtx = ctx.onInject(handleInject);
  const unsubscribeMirror = conversationMirror.onAppend ? conversationMirror.onAppend(handleMirrorAppend) : () => {};

  return {
    dispose(): void {
      disposed = true;
      clearDebounce();
      unsubscribeCtx();
      unsubscribeMirror();
      log.debug("disposed", { sessionId: ctx.sessionId });
    },

    clearPendingConversationSalience(): void {
      clearConversationSalienceImpl();
    },

    clearConversationSalience(): void {
      clearConversationSalienceImpl();
    },
  };

  function clearConversationSalienceImpl(): void {
    const beforeConversation = conversationSalience;
    const beforePendingSalience = pendingSalience;

    conversationSalience = {};

    const ambientExceeds = findExceedingEffect(ambientSalience, config.standardThreshold);
    if (ambientExceeds === null) {
      pendingSalience = false;
    }

    log.debug("clear-pending-conversation-salience", {
      beforeConversation,
      afterConversation: conversationSalience,
      ambientSalience,
      ambientExceeds,
      latchBefore: beforePendingSalience,
      latchAfter: pendingSalience,
      sessionId: ctx.sessionId,
    });
  }
}
