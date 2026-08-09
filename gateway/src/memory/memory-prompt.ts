// System-prompt memory block (Memory System spec §4.5, §4.2): renders the
// per-scope file memory — MEMORY.md body + topic index — into the fixed harness
// block that sits in the session-stable prefix (tier 3, re-rendered only at
// session build). Pure function of its inputs: it reads content ONLY through the
// MemoryStore handles it is given and never touches the clock, the network, or
// the preamble file. The caller (T6 composition) runs `reingestEdits()` on each
// store first and loads the preamble via `loadMemoryPreamble`
// (context/system-prompt-loader.ts), then passes both in — the same split that
// keeps `renderSkillIndex` pure and cache-stable.
//
// Cache-stability (skill-index Invariant A): the SAME memory content MUST render
// to the SAME string across a session's turns, or every turn after a write
// invalidates the provider's prompt cache. Hence a byte-stable topic sort
// (deliberately NOT `localeCompare`, whose collation varies by host locale),
// invisible-char stripping, and whitespace collapse so one topic is exactly one
// line — mirroring skill-index/skill-index.ts.

import { getLog } from "../logging/logger.js";
import { INVISIBLE_CHARS } from "../security/text-normalizer.js";
import type { MemoryConfig, MemoryStore, TopicMeta } from "./memory-store.js";

const log = getLog(["sentient", "memory", "prompt"]);

/** Global variant of the shared single-match `INVISIBLE_CHARS` regex — the
 *  export is `g`-less on purpose (it is used for boolean `.test()` elsewhere),
 *  so a `replace`-all here needs its own global copy or only the FIRST invisible
 *  character is stripped (skill-index precedent). */
const INVISIBLE_CHARS_GLOBAL = new RegExp(INVISIBLE_CHARS.source, "gu");

/** Audience suffix tag (spec §9): a household MEMORY.md line, or a topic index
 *  entry whose description ends with it, is adults-only and omitted from a child
 *  principal's rendered block. Suffix-matched on the trimmed line — deliberately
 *  dumb, no structured parse. */
const ADULTS_TAG = "@adults";

/** Header introducing a scope's topic index inside its envelope. */
const TOPICS_HEADING = "topics:";

const PRIVATE_LABEL = "private";
const FAMILY_LABEL = "family";

export interface MemoryStores {
  /** The speaking user's own scope — never audience-filtered. */
  readonly private: MemoryStore;
  /** The shared household scope. Undefined in S1 (activated in T24); when
   *  present it is audience-filtered for a child principal. */
  readonly household?: MemoryStore;
}

export interface ComposeMemoryOptions {
  /** A child principal never sees `@adults`-tagged household content (§9). */
  readonly childPrincipal: boolean;
  /** The memory preamble, loaded by the caller via `loadMemoryPreamble` so this
   *  renderer stays pure — mirrors `renderSkillIndex(metas, max, preamble)`. */
  readonly preamble: string;
}

/** Byte-stable ascending compare on `name` — deliberately NOT `localeCompare`,
 *  whose collation can vary by host locale and would make the same topic set
 *  render differently on two machines, defeating cache stability. */
function compareByName(a: TopicMeta, b: TopicMeta): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** Collapses a topic description to a single display line: strips invisible
 *  unicode first (it survives the whitespace collapse and could hide a spoofed
 *  boundary), then collapses every whitespace run to one space and trims — so a
 *  description carrying an embedded newline cannot forge a second index line
 *  (skill-index precedent). */
function sanitizeDescription(description: string): string {
  return description.replace(INVISIBLE_CHARS_GLOBAL, "").replace(/\s+/g, " ").trim();
}

/** True when a trimmed file line / description is adults-only. */
function carriesAdultsTag(line: string): boolean {
  return line.trim().endsWith(ADULTS_TAG);
}

/** Drops `@adults`-tagged lines from a MEMORY.md body for a child principal. */
function filterAdultsLines(body: string): string {
  return body
    .split("\n")
    .filter((line) => !carriesAdultsTag(line))
    .join("\n");
}

/** One entry per visible topic, sorted byte-stably by name and sanitized to a
 *  single line. A child principal omits `@adults`-tagged entries. */
function buildTopicLines(topics: TopicMeta[], audienceFiltered: boolean): string[] {
  const visible = audienceFiltered ? topics.filter((t) => !carriesAdultsTag(t.description)) : topics;
  return [...visible].sort(compareByName).map((t) => `- ${t.name} — ${sanitizeDescription(t.description)}`);
}

/** Mutable per-scope render parts — the budget drop steps below mutate these in
 *  place (empty a topic index, truncate a core tail) and re-render. */
interface ScopeParts {
  readonly label: string;
  coreBody: string;
  topicLines: string[];
}

function buildScope(label: string, store: MemoryStore, audienceFiltered: boolean): ScopeParts {
  const rawCore = store.readCore() ?? "";
  const coreBody = audienceFiltered ? filterAdultsLines(rawCore) : rawCore;
  const topicLines = buildTopicLines(store.listTopics(), audienceFiltered);
  return { label, coreBody, topicLines };
}

/** A scope's labeled data envelope, or null when it holds nothing — an empty
 *  `<memory>` element would read to the model as "this person has no memory"
 *  rather than "there is none loaded". */
function renderScope(scope: ScopeParts): string | null {
  const sections: string[] = [];
  const core = scope.coreBody.trim();
  if (core.length > 0) sections.push(core);
  if (scope.topicLines.length > 0) sections.push([TOPICS_HEADING, ...scope.topicLines].join("\n"));
  if (sections.length === 0) return null;
  return `<memory scope="${scope.label}">\n${sections.join("\n\n")}\n</memory>`;
}

/** Full block: preamble, then private envelope, then family envelope (spec
 *  §4.5 order). Empty scopes render nothing; an all-empty block is the preamble
 *  alone. */
function renderBlock(preamble: string, priv: ScopeParts, family: ScopeParts | null): string {
  const envelopes = [renderScope(priv), family ? renderScope(family) : null].filter((s): s is string => s !== null);
  const trimmedPreamble = preamble.trim();
  if (envelopes.length === 0) return trimmedPreamble;
  return [trimmedPreamble, ...envelopes].join("\n\n");
}

/** Drops whole trailing lines from a scope's core body — mutating it in place —
 *  until the whole block fits `budget` or the body is empty. Returns the drop
 *  counts for the WARN (lengths only, never content). */
function truncateCoreTail(
  preamble: string,
  priv: ScopeParts,
  family: ScopeParts | null,
  target: ScopeParts,
  budget: number,
): { droppedLines: number; removedChars: number } {
  const lines = target.coreBody.split("\n");
  let droppedLines = 0;
  let removedChars = 0;
  while (lines.length > 0 && renderBlock(preamble, priv, family).length > budget) {
    const removed = lines.pop() as string;
    removedChars += removed.length + 1; // + the newline that joined it
    droppedLines += 1;
    target.coreBody = lines.join("\n");
  }
  return { droppedLines, removedChars };
}

/**
 * Renders the per-scope file memory into the session-prompt memory block.
 *
 * Pure: reads content only through the given store handles. The whole block is
 * bounded by `cfg.prompt_budget_chars`; when over, parts are dropped in the
 * spec §4.5 deterministic order — family topic index → private topic index →
 * family MEMORY.md tail → private MEMORY.md tail — each drop WARN-logged with
 * lengths only. Write-time caps make this a backstop, not a working path.
 */
export function composeMemoryBlock(stores: MemoryStores, cfg: MemoryConfig, opts: ComposeMemoryOptions): string {
  const { preamble, childPrincipal } = opts;
  const budget = cfg.prompt_budget_chars;

  const priv = buildScope(PRIVATE_LABEL, stores.private, false);
  const family = stores.household ? buildScope(FAMILY_LABEL, stores.household, childPrincipal) : null;

  const withinBudget = (): boolean => renderBlock(preamble, priv, family).length <= budget;

  if (!withinBudget() && family && family.topicLines.length > 0) {
    log.warn("prompt.budget.drop", {
      scope: FAMILY_LABEL,
      part: "topic-index",
      droppedEntries: family.topicLines.length,
    });
    family.topicLines = [];
  }
  if (!withinBudget() && priv.topicLines.length > 0) {
    log.warn("prompt.budget.drop", {
      scope: PRIVATE_LABEL,
      part: "topic-index",
      droppedEntries: priv.topicLines.length,
    });
    priv.topicLines = [];
  }
  if (!withinBudget() && family && family.coreBody.trim().length > 0) {
    const dropped = truncateCoreTail(preamble, priv, family, family, budget);
    if (dropped.droppedLines > 0)
      log.warn("prompt.budget.drop", { scope: FAMILY_LABEL, part: "core-tail", ...dropped });
  }
  if (!withinBudget() && priv.coreBody.trim().length > 0) {
    const dropped = truncateCoreTail(preamble, priv, family, priv, budget);
    if (dropped.droppedLines > 0)
      log.warn("prompt.budget.drop", { scope: PRIVATE_LABEL, part: "core-tail", ...dropped });
  }

  const rendered = renderBlock(preamble, priv, family);
  log.debug("prompt.rendered", {
    chars: rendered.length,
    budget,
    privateTopics: priv.topicLines.length,
    familyTopics: family ? family.topicLines.length : 0,
    hasFamily: family !== null,
  });
  return rendered;
}
