// System-prompt skill index (Skill System spec, Task 6): renders the operator's
// installed SkillMeta set into the fixed harness block that tells the model
// which skills exist and that it MUST call `skill_use` before acting on a
// matching request. Pure function of its inputs — no filesystem, no clock —
// so it stays trivially testable and, more importantly, byte-stable: the
// SAME skill set MUST render to the SAME string across turns, or every turn
// after a skill is added/edited invalidates the provider's prompt cache from
// that point on (Invariant A).
//
// The preamble text itself is NOT read here — it is loaded once by
// `context/system-prompt-loader.ts` (`loadSkillIndexPreamble`, same two-tier
// baked/operator-override shape as the compaction summarizer) and passed in,
// keeping this module free of I/O.

import { getLog } from "../logging/logger.js";
import type { SkillMeta } from "./skill-store.js";

const log = getLog(["sentient", "skills", "index"]);

/** Byte-stable ascending compare — deliberately NOT `localeCompare`, whose
 *  collation can vary by host locale and would make the "same skill set"
 *  render differently on two machines, defeating the cache-stability
 *  invariant this module exists to uphold. */
function compareByName(a: SkillMeta, b: SkillMeta): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** SELECT-step tie-break: newest-by-`updatedAt` first, ties broken by name
 *  ascending. Without this, two skills sharing an `updatedAt` (a legal,
 *  common case — bulk import, clock resolution) sort in whatever order
 *  `Array.prototype.sort` happens to hand back for equal keys, which in
 *  practice follows `readdir` input order — NOT byte-stable, contradicting
 *  the module's own cache-stability contract at the cap boundary. */
function compareNewestThenName(a: SkillMeta, b: SkillMeta): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return compareByName(a, b);
}

/** Collapses a description to a single display line. A `SkillMeta.description`
 *  is a free-form YAML string — T4 validates only its length, so newlines,
 *  tabs, and other control/whitespace characters are legal content. Rendered
 *  raw, an embedded `"\n- fake-skill — ..."` would print as an indistinguishable
 *  second bullet line: a forged sibling skill entry injected into the system
 *  prompt by whoever wrote that description. Collapsing every whitespace run
 *  to a single space, before interpolation, is what keeps one `SkillMeta`
 *  worth exactly one bullet line, always. */
function sanitizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

/**
 * Renders the installed skill set into the system-prompt block.
 *
 * - `metas` empty -> `""` (no skills installed, nothing to inject).
 * - Otherwise: `preamble` followed by one `- name — description` line per
 *   skill.
 * - When `metas.length > maxEntries`: SELECT the newest `maxEntries` skills
 *   by `updatedAt`, ties broken by name (a full skill set no longer fits the
 *   prompt budget, so the most recently taught/edited skills win; the name
 *   tie-break makes the selection itself deterministic when `updatedAt`
 *   collides), then RENDER the kept set sorted by name — the render step's
 *   own re-sort is what keeps the OUTPUT byte-identical for a fixed kept set
 *   regardless of how that set was assembled. WARNs with the dropped count
 *   so an operator can see the budget was exceeded.
 */
export function renderSkillIndex(metas: SkillMeta[], maxEntries: number, preamble: string): string {
  if (metas.length === 0) return "";

  let kept = metas;
  if (metas.length > maxEntries) {
    const newestFirst = [...metas].sort(compareNewestThenName);
    kept = newestFirst.slice(0, maxEntries);
    const dropped = metas.length - maxEntries;
    log.warn("skill-index.overflow", { total: metas.length, maxEntries, dropped });
  }

  const lines = [...kept]
    .sort(compareByName)
    .map((skill) => `- ${skill.name} — ${sanitizeDescription(skill.description)}`);

  log.debug("skill-index.rendered", { total: metas.length, rendered: lines.length });

  return `${preamble.trim()}\n\n${lines.join("\n")}`;
}
