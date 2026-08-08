// SKILL.md frontmatter + body parsing, validation, and serialization
// (Skill System spec, Task 4). Mirrors the delegation-guard.ts frontmatter
// convention (YAML fence + `yaml` package, never hand-rolled key:value
// parsing) but adds the structural + unicode-lint validation a
// self-authored, user-writable skill file needs that an operator-only
// delegation envelope does not.
//
// Never throws: every failable path returns a typed `SkillFileError`
// (error-handling rule) so a single malformed skill file cannot crash a
// caller mid-loop.

import { parse, stringify } from "yaml";
import { z } from "zod";
import { getLog } from "../logging/logger.js";
import { INVISIBLE_CHARS } from "../security/text-normalizer.js";

const log = getLog(["sentient", "skills", "skill-file"]);

/** `^[a-z0-9][a-z0-9-]{0,63}$` — lowercase-kebab, 1-64 chars, no leading hyphen. */
export const SKILL_NAME_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Hard cap on `description` length — kept short since it is what the
 *  orchestrator's tool-catalog prompt shows verbatim per skill. */
export const MAX_DESCRIPTION_CHARS = 1024;

/** Longest error `detail` string returned to a caller, mirroring the
 *  logging rule's ≤120-char preview cap — a YAML/zod error message can
 *  otherwise echo back large chunks of the offending source. */
const ERROR_DETAIL_MAX_CHARS = 120;

const FRONTMATTER_FENCE = "---";

export interface SkillFrontmatter {
  name: string;
  description: string;
  tools?: string[];
}

export interface SkillFile extends SkillFrontmatter {
  body: string;
}

export type SkillFileError =
  | { kind: "bad_name"; name: string }
  | { kind: "description_too_long"; length: number }
  | { kind: "body_too_long"; length: number; max: number }
  | { kind: "invisible_chars"; count: number }
  | { kind: "malformed_frontmatter"; detail: string }
  | { kind: "unknown_tools"; tools: string[] };

const frontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  tools: z.array(z.string()).optional(),
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

// ---------------------------------------------------------------------------
// Structural + unicode-lint validation (shared by parse and validate paths)
// ---------------------------------------------------------------------------

/** Counts codepoints matching `INVISIBLE_CHARS` (zero-width, Unicode Tags
 *  block, bidi overrides). `INVISIBLE_CHARS` is deliberately non-`g`-flagged
 *  (safe for repeated `.test()`), so counting re-derives a local `gu`-flagged
 *  instance rather than reusing the shared one. */
function countInvisibleChars(text: string): number {
  const re = new RegExp(INVISIBLE_CHARS.source, "gu");
  return [...text.matchAll(re)].length;
}

/** Structural checks common to `parseSkillFile` and `validateSkillInput`:
 *  name shape, description cap, body cap, invisible-char lint on the body
 *  (fail closed — a self-authored body has no legitimate reason to carry
 *  zero-width/tags-block/bidi chars; per the CSA skill-file attack note).
 *  Does NOT check `tools` against a known-tool registry — that requires the
 *  caller-supplied `knownTools` set `validateSkillInput` alone takes. */
function validateStructural(input: SkillFile, maxBodyChars: number): SkillFileError | null {
  if (!SKILL_NAME_RE.test(input.name)) {
    return { kind: "bad_name", name: input.name };
  }
  if (input.description.length > MAX_DESCRIPTION_CHARS) {
    return { kind: "description_too_long", length: input.description.length };
  }
  if (input.body.length > maxBodyChars) {
    return { kind: "body_too_long", length: input.body.length, max: maxBodyChars };
  }
  const invisibleCount = countInvisibleChars(input.body);
  if (invisibleCount > 0) {
    return { kind: "invisible_chars", count: invisibleCount };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parses a raw SKILL.md string (frontmatter fence + YAML + body) into a
 *  `SkillFile`, applying structural + unicode-lint validation. Does not
 *  check `tools` against a tool registry — callers that have a registry
 *  should follow up with `validateSkillInput`. Never throws. */
export function parseSkillFile(
  raw: string,
  opts: { maxBodyChars: number },
): { ok: true; skill: SkillFile } | { ok: false; error: SkillFileError } {
  const split = splitFrontmatter(raw);
  if (!split) {
    const error: SkillFileError = {
      kind: "malformed_frontmatter",
      detail: "missing or unclosed '---' frontmatter fence",
    };
    log.warn("skill-file.parse.malformed", { reason: error.detail });
    return { ok: false, error };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parse(split.frontmatterText);
  } catch (err) {
    const error: SkillFileError = { kind: "malformed_frontmatter", detail: describeError(err) };
    log.warn("skill-file.parse.invalid-yaml", { reason: error.detail });
    return { ok: false, error };
  }

  const fmResult = frontmatterSchema.safeParse(parsedYaml);
  if (!fmResult.success) {
    const error: SkillFileError = {
      kind: "malformed_frontmatter",
      detail: describeError(fmResult.error),
    };
    log.warn("skill-file.parse.schema-mismatch", { reason: error.detail });
    return { ok: false, error };
  }

  const skill: SkillFile = {
    name: fmResult.data.name,
    description: fmResult.data.description,
    ...(fmResult.data.tools ? { tools: fmResult.data.tools } : {}),
    body: split.body,
  };

  const structuralError = validateStructural(skill, opts.maxBodyChars);
  if (structuralError) {
    log.warn("skill-file.parse.invalid", { name: skill.name, kind: structuralError.kind });
    return { ok: false, error: structuralError };
  }

  log.debug("skill-file.parse.ok", { name: skill.name, bodyLength: skill.body.length });
  return { ok: true, skill };
}

/** Validates an already-constructed `SkillFile` — the structural +
 *  unicode-lint checks `parseSkillFile` runs, plus `tools` membership
 *  against `knownTools`. Returns `null` when valid. Never throws. */
export function validateSkillInput(
  input: SkillFile,
  opts: { maxBodyChars: number; knownTools: ReadonlySet<string> },
): SkillFileError | null {
  const structuralError = validateStructural(input, opts.maxBodyChars);
  if (structuralError) return structuralError;

  if (input.tools && input.tools.length > 0) {
    const unknown = input.tools.filter((tool) => !opts.knownTools.has(tool));
    if (unknown.length > 0) {
      return { kind: "unknown_tools", tools: unknown };
    }
  }

  return null;
}

/** Serializes a `SkillFile` back to raw SKILL.md text (frontmatter fence +
 *  YAML + body). Round-trips through `parseSkillFile` for any skill that
 *  itself passes structural validation. */
export function serializeSkillFile(skill: SkillFile): string {
  const frontmatter: SkillFrontmatter = { name: skill.name, description: skill.description };
  if (skill.tools) {
    frontmatter.tools = skill.tools;
  }
  const yamlBlock = stringify(frontmatter).trimEnd();
  return `${FRONTMATTER_FENCE}\n${yamlBlock}\n${FRONTMATTER_FENCE}\n${skill.body}`;
}
