// Dreamer input projection (memory-system spec §8 "Input projection", §3.1
// "Provenance with taint propagation") — session-store entries → the batch
// windows the nightly dreamer distills.
//
// Pure and deterministic: same entries in, byte-identical windows out. The
// dreamer's map step reads one `DreamSession` per call, so this groups the
// window's entries BY SESSION (first-appearance order), each rendered as a
// compact, append-ordered, seq-marked transcript.
//
// SECURITY-RELEVANT. `containsToolDerived` is the taint bit spec §3.1
// propagates: an episode summary or fact distilled from a session window that
// contained ANY tool-derived entry inherits `tool-derived` provenance — "no
// laundering to `assistant` through the LLM pass". The classifier here is the
// choke point that decides which entries are tool-derived, and it is
// deliberately CONSERVATIVE:
//   - `tool_result` is tool-derived (the tool's untrusted return).
//   - `trigger` is tool-derived too. A trigger is a background-completion
//     stimulus (session-runtime.ts `stimulusEntryKind`): a delegated agent that
//     read the open web, projected as its own turn. Treating it as user-speech
//     would launder untrusted output into the highest-trust channel — the exact
//     hole a review caught. It carries the person's-eye speaker label in text
//     (so the dreamer reads it in context) but taints the window.
//   - An UNKNOWN kind fails conservative: tainted, with a WARN. The store's read
//     path casts `row.kind` with no runtime validation (session-store.ts), so a
//     foreign/corrupt row can reach here; it must never silently pass as trusted.
//   - `tool_call` is structural, not tool-derived: it is the assistant's own
//     decision to call, and its untrusted RESULT is the `tool_result` that
//     carries the taint. It folds into that result's digest and renders no
//     standalone line. `system`/`compaction` are skipped entirely — not in the
//     text (compaction shrinks the model replay, never the dreamer's raw view;
//     the raw entries it summarized are still present in the window), not in the
//     taint.
//
// No memory content is logged (global constraint) — counts, seqs, and kinds only.

import { getLog } from "../logging/logger.js";
import type { CutoffKind, EntryKind, SessionEntry } from "./entry-types.js";

const log = getLog(["sentient", "store", "project-for-dreaming"]);

/** One session's slice of the dream window. */
export interface DreamSession {
  sessionId: string;
  /** Append-ordered, seq-marked transcript of the session's windowed entries. */
  text: string;
  /** True iff ANY included entry classified tool-derived (spec §3.1 taint). */
  containsToolDerived: boolean;
}

/** The dreamer's immutable input for one run: `(fromSeq, toSeq]` grouped by session. */
export interface DreamWindow {
  sessions: DreamSession[];
}

/** Speaker label per rendered conversational kind. `Trigger` is a
 *  background/system stimulus that landed as its own turn — labelled so the
 *  dreamer can tell it from a person's message even though it TAINTS. */
const SPEAKER_LABEL: Record<"user" | "assistant" | "trigger", string> = {
  user: "User",
  assistant: "Assistant",
  trigger: "Trigger",
};

/** How one entry participates in a session's projection. */
interface Classified {
  /** Sets `containsToolDerived` for the whole session when true. */
  readonly taints: boolean;
  /** Rendered transcript line, or null when the entry contributes no standalone
   *  text (folded into a digest, or skipped). */
  readonly line: string | null;
}

function cutoffSuffix(cutoff: CutoffKind | null): string {
  return cutoff === null ? "" : ` [cut off: ${cutoff}]`;
}

/** `[tool <name> → <n> chars]` — the labeled digest that collapses a tool
 *  round-trip. `<n>` is the result-text length; the result text follows so the
 *  dreamer has the content, the digest just marks its provenance visually. */
function toolDigest(entry: SessionEntry): string {
  const name = entry.toolName ?? "unknown";
  const resultLength = (entry.toolArgs ?? "").length;
  return `[tool ${name} → ${resultLength} chars]`;
}

/**
 * The source-kind → provenance classifier. ONE switch owns both the taint bit
 * and the rendered line so the two can never drift apart — the security
 * property (taint) and the visible one (text) are decided together.
 */
function classifyEntry(entry: SessionEntry): Classified {
  const seq = entry.seq;
  const text = entry.text ?? "";
  switch (entry.kind) {
    case "user":
      return { taints: false, line: `#${seq} ${SPEAKER_LABEL.user}: ${text}` };
    case "assistant":
      return { taints: false, line: `#${seq} ${SPEAKER_LABEL.assistant}: ${text}${cutoffSuffix(entry.cutoff)}` };
    case "trigger":
      // Background-completion stimulus — untrusted origin. Rendered for context,
      // but taints (spec §3.1; the laundering hole a review caught).
      return { taints: true, line: `#${seq} ${SPEAKER_LABEL.trigger}: ${text}` };
    case "tool_result":
      return { taints: true, line: `#${seq} ${toolDigest(entry)} ${entry.toolArgs ?? ""}` };
    case "tool_call":
      // Folded into its result's digest; the RESULT carries the taint.
      return { taints: false, line: null };
    case "system":
    case "compaction":
      // Not text, not taint — the raw entries a compaction summarized are still
      // present in the window; the summary itself is skipped.
      return { taints: false, line: null };
    default:
      // Foreign/corrupt kind (unvalidated at the store read path). Fail
      // conservative: taint the window rather than pass it as trusted.
      log.warn("project-for-dreaming.unknown-kind", { kind: entry.kind as string, seq });
      return { taints: true, line: `#${seq} [unknown kind ${entry.kind as string}] ${text}` };
  }
}

/** In-window entry: `(fromSeq, toSeq]` — exclusive lower bound, inclusive upper. */
function isWithinWindow(seq: number, fromSeq: number, toSeq: number): boolean {
  return seq > fromSeq && seq <= toSeq;
}

interface SessionAccumulator {
  sessionId: string;
  lines: string[];
  containsToolDerived: boolean;
}

/**
 * Projects a session-store window into the dreamer's per-session input.
 *
 * Pure and deterministic. Entries are consumed in the order given (append order
 * — how the store returns them); this function does not reorder. Only entries
 * with `fromSeq < seq <= toSeq` are included. Sessions appear in first-seen
 * order; within a session, entries stay in append order.
 */
export function projectForDreaming(entries: readonly SessionEntry[], fromSeq: number, toSeq: number): DreamWindow {
  const bySession = new Map<string, SessionAccumulator>();
  const order: string[] = [];
  let includedCount = 0;
  let taintedEntryCount = 0;

  for (const entry of entries) {
    if (!isWithinWindow(entry.seq, fromSeq, toSeq)) continue;
    includedCount += 1;

    let acc = bySession.get(entry.sessionId);
    if (acc === undefined) {
      acc = { sessionId: entry.sessionId, lines: [], containsToolDerived: false };
      bySession.set(entry.sessionId, acc);
      order.push(entry.sessionId);
    }

    const classified = classifyEntry(entry);
    if (classified.taints) {
      acc.containsToolDerived = true;
      taintedEntryCount += 1;
    }
    if (classified.line !== null) acc.lines.push(classified.line);
  }

  const sessions: DreamSession[] = order.map((sessionId) => {
    const acc = bySession.get(sessionId);
    return {
      sessionId,
      text: acc?.lines.join("\n") ?? "",
      containsToolDerived: acc?.containsToolDerived ?? false,
    };
  });

  const taintedSessions = sessions.filter((s) => s.containsToolDerived).length;
  log.debug("project-for-dreaming.projected", {
    fromSeq,
    toSeq,
    total: entries.length,
    included: includedCount,
    sessions: sessions.length,
    taintedSessions,
    taintedEntries: taintedEntryCount,
  });

  return { sessions };
}

/** Re-exported for callers reasoning about the classifier's known kinds. */
export type { EntryKind };
