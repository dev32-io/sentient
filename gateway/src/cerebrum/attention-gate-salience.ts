import { getLog } from "../logging/logger.js";
import type { MirrorEntry } from "./conversation-mirror.js";
import type { ContextEvent, SalienceMap } from "./short-term-context-types.js";

const log = getLog(["sentient", "cerebrum", "attention-gate-salience"]);

/**
 * Maps a ConversationMirror append entry to the salience key that represents
 * it in the salience map. Returns `null` for entries that should not
 * contribute salience (assistant / tool — self-output).
 */
export function salienceKeyForMirrorEntry(entry: MirrorEntry): string | null {
  if (entry.kind === "assistant" || entry.kind === "tool") return null;
  if (entry.kind === "trigger") {
    // React-budget warnings are internal budget notices injected by the gate
    // itself — they must NOT re-wake the gate (would create an infinite loop).
    if (entry.source === "react-budget") return null;
    return "conversation.trigger";
  }
  // entry.kind === "user"
  if (entry.channel === "speech") return "conversation.user.speech";
  return "conversation.user.text";
}

/**
 * Maps a ShortTermContext inject event to the salience key. Returns `null` for
 * events that should not contribute salience to the accumulator.
 *
 * User events no longer flow through STC — they travel via ConversationMirror
 * exclusively and are counted by the mirror append path in AttentionGate.
 */
export function salienceKeyForInjectEvent(event: ContextEvent): string | null {
  return event.kind;
}

/**
 * Adds the salience weights for `key` from `salienceMap` into `accumulator`,
 * mutating it in place. Returns the updated accumulator for convenience.
 */
export function accumulateSalience(
  accumulator: Record<string, number>,
  key: string,
  salienceMap: SalienceMap,
  context: { sessionId: string; source: string },
): Record<string, number> {
  const weights = salienceMap.lookup(key);
  const entries = Object.entries(weights);
  if (entries.length === 0) {
    log.debug("salience-lookup-empty", {
      salienceKey: key,
      source: context.source,
      sessionId: context.sessionId,
    });
    return accumulator;
  }
  for (const [effect, weight] of entries) {
    const prev = accumulator[effect] ?? 0;
    accumulator[effect] = prev + weight;
    log.debug("salience-accumulated", {
      salienceKey: key,
      effect,
      weight,
      prev,
      next: accumulator[effect],
      accumulatorSnapshot: { ...accumulator },
      source: context.source,
      sessionId: context.sessionId,
    });
  }
  return accumulator;
}

/**
 * Finds the first effect in `accumulator` whose total exceeds `threshold`.
 * Returns the effect name, or `null` if none exceed it.
 */
export function findExceedingEffect(accumulator: Readonly<Record<string, number>>, threshold: number): string | null {
  for (const [effect, value] of Object.entries(accumulator)) {
    if (value > threshold) return effect;
  }
  return null;
}

/**
 * Returns a new record containing the element-wise sum of `a` and `b`.
 * Does not mutate either argument.
 */
export function mergeSalience(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [effect, weight] of Object.entries(b)) {
    merged[effect] = (merged[effect] ?? 0) + weight;
  }
  return merged;
}
