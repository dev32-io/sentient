// Session-transcript excerpt renderer (memory-system spec §7) — the read-time
// projection behind `memory_read({sessionId, around?, offset?})`, the second
// round-trip of deliberate remembering. A `memory_recall` hit names a past
// `sessionId` and an entry span; this renders the actual moment as a compact,
// speaker-labelled transcript the model can read back.
//
// CLIENT-PROJECTION-SHAPED, NOT FOLDED. It filters to the SAME visible kinds as
// `client-projection.ts` (user / assistant / trigger; tool_call, tool_result,
// system and compaction never render), so what the model reads back matches
// what the person saw. It does NOT fold an assistant reply's stretches into one
// bubble the way the live feed does: a drill-down centres on a specific entry
// `seq`, so every line carries its own `#<seq>` marker and stays addressable.
//
// WINDOWED. `around` centres a ± `contextEntries` window on the nearest
// renderable entry; `offset` pages forward from a renderable-entry index; with
// neither, the whole session renders (the caller's `capToolResult` then bounds
// the size). Whenever the window clips either end, a marker names how many
// entries were dropped and — on the forward end — the `offset` to continue
// with, so paging is possible without the model inventing an index.
//
// No memory content is logged (global constraint) — only counts.

import { getLog } from "../logging/logger.js";
import type { EntryKind, SessionEntry } from "./entry-types.js";

const log = getLog(["sentient", "store", "session-excerpt"]);

export interface SessionExcerptOptions {
  /** Entry `seq` to centre the window on (a recall hit's entry). */
  around?: number;
  /** Renderable-entry index to page forward from (continuation). */
  offset?: number;
  /** Window radius around `around`, in renderable entries (`memory.recall.context_entries`). */
  contextEntries: number;
}

/** The kinds that render — identical to `client-projection.ts`'s visible set. */
const RENDER_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(["user", "assistant", "trigger"]);

/** Speaker label per renderable kind. `trigger` is a background/system stimulus
 *  that landed as its own turn — labelled so the model can tell it from a
 *  person's message. */
const SPEAKER_LABEL: Record<"user" | "assistant" | "trigger", string> = {
  user: "User",
  assistant: "Assistant",
  trigger: "Trigger",
};

function speakerFor(kind: EntryKind): string {
  return kind === "user" || kind === "assistant" || kind === "trigger" ? SPEAKER_LABEL[kind] : kind;
}

function renderLine(entry: SessionEntry): string {
  return `#${entry.seq} ${speakerFor(entry.kind)}: ${entry.text ?? ""}`;
}

function leadingMarker(omitted: number): string {
  return `[... ${omitted} earlier ${omitted === 1 ? "entry" : "entries"} omitted — this is a later part of the conversation ...]`;
}

function trailingMarker(omitted: number, continueOffset: number): string {
  return `[... ${omitted} later ${omitted === 1 ? "entry" : "entries"} omitted — continue with offset ${continueOffset} ...]`;
}

/** The renderable-entry index the window centres on: the first entry at or
 *  after `around`, or the last renderable entry when `around` is past the end. */
function centerIndex(renderable: readonly SessionEntry[], around: number): number {
  const at = renderable.findIndex((e) => e.seq >= around);
  return at === -1 ? renderable.length - 1 : at;
}

/** The [start, end] renderable-entry window (both inclusive) the options select. */
function windowBounds(renderable: readonly SessionEntry[], opts: SessionExcerptOptions): [number, number] {
  const last = renderable.length - 1;
  if (opts.around !== undefined) {
    const center = centerIndex(renderable, opts.around);
    return [Math.max(0, center - opts.contextEntries), Math.min(last, center + opts.contextEntries)];
  }
  if (opts.offset !== undefined && opts.offset > 0) {
    return [Math.min(opts.offset, renderable.length), last];
  }
  return [0, last];
}

/**
 * Renders a windowed, speaker-labelled excerpt of one session's transcript.
 * Returns `""` when the session has no renderable entries — the caller maps
 * that to a not-found tool error.
 */
export function renderSessionExcerpt(entries: readonly SessionEntry[], opts: SessionExcerptOptions): string {
  const renderable = entries.filter((e) => RENDER_KINDS.has(e.kind));
  if (renderable.length === 0) {
    log.debug("session-excerpt.empty", { total: entries.length });
    return "";
  }

  const [start, end] = windowBounds(renderable, opts);
  const windowEntries = renderable.slice(start, end + 1);
  const lines = windowEntries.map(renderLine);

  if (start > 0) lines.unshift(leadingMarker(start));
  const trailingOmitted = renderable.length - 1 - end;
  if (trailingOmitted > 0) lines.push(trailingMarker(trailingOmitted, end + 1));

  log.debug("session-excerpt.rendered", {
    total: entries.length,
    renderable: renderable.length,
    shown: windowEntries.length,
    start,
    end,
  });
  return lines.join("\n");
}
