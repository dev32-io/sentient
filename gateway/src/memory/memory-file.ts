// Memory-file format + validation (Memory System spec §4.2, §4.3). The
// memory-file analog of `../skills/skill-file.ts`: frontmatter parsing for
// topic notes (`topics/<slug>.md`) via the existing `yaml` package + zod,
// plus the plain-text cap validation shared by `MEMORY.md` and topic bodies.
// `MEMORY.md` itself carries no frontmatter — it is bare markdown (spec
// §4.2) — so only topic files go through `parseTopicFile`/`serializeTopicFile`.
//
// Never throws: every failable path returns a typed result (error-handling
// rule) so a single malformed memory file cannot crash a caller mid-loop.

import { parse, stringify } from "yaml";
import { z } from "zod";
import { getLog } from "../logging/logger.js";
import { INVISIBLE_CHARS } from "../security/text-normalizer.js";

const log = getLog(["sentient", "memory", "memory-file"]);

/** `^[a-z0-9][a-z0-9-]{0,63}$` — lowercase-kebab, 1-64 chars, no leading
 *  hyphen. Shared by topic-file `name` and the `topics/<slug>.md` path
 *  segment — rejecting `/`, `.`, and uppercase by construction is what
 *  makes a traversal-shaped slug (`../etc/passwd`) fail this regex rather
 *  than needing a separate path check. */
export const MEMORY_SLUG_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Description length cap, mirroring `skill-file.ts`'s `MAX_DESCRIPTION_CHARS`.
 *  A topic `description` is rendered verbatim into the system-prompt topic
 *  index (spec §4.5) yet — unlike the body — is neither line/char-capped by
 *  `validateMemoryText` nor invisible-char linted anywhere else, so an
 *  unbounded or zero-width-laden description is a prompt-budget and injection
 *  surface. Bounding it here (the read/re-ingest parse gate) makes a poisoned
 *  description render ABSENT rather than reach the prompt. */
export const MAX_DESCRIPTION_CHARS = 1024;

const FRONTMATTER_FENCE = "---";

/** Longest error `detail` string returned to a caller, mirroring the
 *  logging rule's ≤120-char preview cap — a YAML/zod error message can
 *  otherwise echo back large chunks of the offending source. */
const ERROR_DETAIL_MAX_CHARS = 120;

export interface TopicFrontmatter {
  name: string;
  description: string;
}

export interface TopicFile extends TopicFrontmatter {
  body: string;
}

export type TopicFileError =
  | { kind: "bad_name"; name: string }
  | { kind: "description_too_long"; length: number }
  | { kind: "invisible_chars"; count: number }
  | { kind: "malformed_frontmatter"; detail: string };

const topicFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
});

// ---------------------------------------------------------------------------
// Frontmatter fence splitting
// ---------------------------------------------------------------------------

interface FrontmatterSplit {
  frontmatterText: string;
  body: string;
}

/** Splits `raw` on the leading `---\n`…`\n---\n` fence. Returns `null` when
 *  the opening or closing delimiter is missing — the caller folds that into
 *  `malformed_frontmatter` rather than throwing. */
function splitFrontmatter(raw: string): FrontmatterSplit | null {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return null;
  const closeIndex = lines.findIndex((line, i) => i > 0 && line.trim() === FRONTMATTER_FENCE);
  if (closeIndex < 0) return null;
  return {
    frontmatterText: lines.slice(1, closeIndex).join("\n"),
    body: lines.slice(closeIndex + 1).join("\n"),
  };
}

/** Truncates an error message to a bounded preview — never echoes an
 *  unbounded YAML/zod error (which can itself contain source snippets)
 *  back to the caller. */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > ERROR_DETAIL_MAX_CHARS ? `${message.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : message;
}

/** Counts codepoints matching `INVISIBLE_CHARS` (zero-width, Unicode Tags
 *  block, bidi overrides). `INVISIBLE_CHARS` is deliberately non-`g`-flagged
 *  (safe for repeated `.test()`), so counting re-derives a local `gu`-flagged
 *  instance rather than reusing the shared one. */
function countInvisibleChars(text: string): number {
  const re = new RegExp(INVISIBLE_CHARS.source, "gu");
  return [...text.matchAll(re)].length;
}

// ---------------------------------------------------------------------------
// Public API — topic file frontmatter
// ---------------------------------------------------------------------------

/** Parses a raw topic-file string (frontmatter fence + YAML + body) into a
 *  `TopicFile`, validating the slug shape and rejecting invisible chars in
 *  the body fail-closed (spec §4.2: "slug regex …, invisible-char rejection
 *  (skill-file.ts discipline)"). Does not enforce the line/char caps —
 *  callers compose with `validateMemoryText` for that. Never throws. */
export function parseTopicFile(raw: string): { ok: true; topic: TopicFile } | { ok: false; error: TopicFileError } {
  const split = splitFrontmatter(raw);
  if (!split) {
    const error: TopicFileError = {
      kind: "malformed_frontmatter",
      detail: "missing or unclosed '---' frontmatter fence",
    };
    log.warn("memory-file.parse.malformed", { reason: error.detail });
    return { ok: false, error };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parse(split.frontmatterText);
  } catch (err) {
    const error: TopicFileError = { kind: "malformed_frontmatter", detail: describeError(err) };
    log.warn("memory-file.parse.invalid-yaml", { reason: error.detail });
    return { ok: false, error };
  }

  const fmResult = topicFrontmatterSchema.safeParse(parsedYaml);
  if (!fmResult.success) {
    const error: TopicFileError = {
      kind: "malformed_frontmatter",
      detail: describeError(fmResult.error),
    };
    log.warn("memory-file.parse.schema-mismatch", { reason: error.detail });
    return { ok: false, error };
  }

  if (!MEMORY_SLUG_RE.test(fmResult.data.name)) {
    const error: TopicFileError = { kind: "bad_name", name: fmResult.data.name };
    log.warn("memory-file.parse.invalid", { kind: error.kind });
    return { ok: false, error };
  }

  // Description guard (folded-in review): the description is rendered into the
  // prompt topic index, so it is length-capped and invisible-char linted here
  // exactly as the body is — the ONE frontmatter field that otherwise reaches
  // the prompt unscanned.
  if (fmResult.data.description.length > MAX_DESCRIPTION_CHARS) {
    const error: TopicFileError = { kind: "description_too_long", length: fmResult.data.description.length };
    log.warn("memory-file.parse.invalid", { name: fmResult.data.name, kind: error.kind });
    return { ok: false, error };
  }

  const descriptionInvisibleCount = countInvisibleChars(fmResult.data.description);
  if (descriptionInvisibleCount > 0) {
    const error: TopicFileError = { kind: "invisible_chars", count: descriptionInvisibleCount };
    log.warn("memory-file.parse.invalid", { name: fmResult.data.name, kind: error.kind, field: "description" });
    return { ok: false, error };
  }

  const invisibleCount = countInvisibleChars(split.body);
  if (invisibleCount > 0) {
    const error: TopicFileError = { kind: "invisible_chars", count: invisibleCount };
    log.warn("memory-file.parse.invalid", { name: fmResult.data.name, kind: error.kind });
    return { ok: false, error };
  }

  const topic: TopicFile = {
    name: fmResult.data.name,
    description: fmResult.data.description,
    body: split.body,
  };
  log.debug("memory-file.parse.ok", { name: topic.name, bodyLength: topic.body.length });
  return { ok: true, topic };
}

/** Serializes topic frontmatter + body back to raw topic-file text
 *  (frontmatter fence + YAML + body). Round-trips through `parseTopicFile`
 *  for any topic that itself passes validation. */
export function serializeTopicFile(meta: TopicFrontmatter, body: string): string {
  const yamlBlock = stringify({ name: meta.name, description: meta.description }).trimEnd();
  return `${FRONTMATTER_FENCE}\n${yamlBlock}\n${FRONTMATTER_FENCE}\n${body}`;
}

// ---------------------------------------------------------------------------
// Public API — cap validation (MEMORY.md and topic bodies alike, spec §4.3)
// ---------------------------------------------------------------------------

/** Line/char usage of a memory text, as reported in every `memory_write`
 *  result (spec §4.3: "lines 212/300, chars 8.4k/12k"). Lines is the count
 *  of `\n`-separated segments (an empty string is 1 line, matching how an
 *  editor reports line counts); chars is the UTF-16 code-unit length. */
export interface MemoryUsage {
  lines: number;
  chars: number;
}

/** Counts lines and chars in `text` — the raw usage numbers a caller
 *  formats into the tool-contract usage report. Pure, never throws. */
export function countUsage(text: string): MemoryUsage {
  return { lines: text.split("\n").length, chars: text.length };
}

export interface MemoryCapOptions {
  /** Max line count, inclusive — a text with exactly `maxLines` lines passes. */
  maxLines: number;
  /** Max char count, inclusive — a text with exactly `maxChars` chars passes. */
  maxChars: number;
}

export type MemoryCapError = "cap_lines" | "cap_chars" | "invisible_chars";

export type MemoryValidationResult = { ok: true } | { ok: false; error: MemoryCapError; lines: number; chars: number };

/** Validates a memory text (MEMORY.md body or topic body) against the
 *  dual line/char caps and the invisible-char lint — the write-time gate
 *  spec §4.3 requires ("a write that would exceed a cap is refused …
 *  never silent truncation"). Caps are checked before the invisible-char
 *  lint since an oversized write is refused on size alone regardless of
 *  content. Never throws. */
export function validateMemoryText(text: string, opts: MemoryCapOptions): MemoryValidationResult {
  const usage = countUsage(text);

  if (usage.lines > opts.maxLines) {
    log.warn("memory-file.validate.cap_lines", { lines: usage.lines, maxLines: opts.maxLines });
    return { ok: false, error: "cap_lines", lines: usage.lines, chars: usage.chars };
  }
  if (usage.chars > opts.maxChars) {
    log.warn("memory-file.validate.cap_chars", { chars: usage.chars, maxChars: opts.maxChars });
    return { ok: false, error: "cap_chars", lines: usage.lines, chars: usage.chars };
  }

  const invisibleCount = countInvisibleChars(text);
  if (invisibleCount > 0) {
    log.warn("memory-file.validate.invisible_chars", { count: invisibleCount });
    return { ok: false, error: "invisible_chars", lines: usage.lines, chars: usage.chars };
  }

  return { ok: true };
}
