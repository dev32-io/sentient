// The four gateway-native memory tools (Memory System spec §4.4) — the model's
// read/write surface over the per-scope file memory store (T3b). Each is a
// `NativeToolRunner` (tool-broker.ts) the broker awaits in-turn exactly like an
// MCP call, resolving its permission under the reserved `"native"` namespace
// (`NATIVE_TOOL_SERVER_KEY`), settings-projected like the skill tools.
//
// TWO STAGES, same split as skill-tools:
//   - `validate` (run BEFORE the PDP) answers every STRUCTURAL question — arg
//     shape, target/op validity, the family-scope ROLE gate (adult-only, spec
//     §4.4: the role table gives children the `write` tier, so the scope check
//     MUST be explicit here, not left to the tier), and the write-time
//     injection scan of the incoming content. A non-null return is a plain tool
//     error the model relays, with NO permission prompt spent.
//   - `run` executes the validated request against the store. It re-parses
//     defensively (`validate` is contractually optional) and maps every store
//     outcome to legible copy.
//
// SLICE SCOPE (S1). This task implements FILE-target memory only. Deep memory
// (`memory_recall`, and `memory_read` with a `{sessionId}` target) is the
// DeepMemoryService's job in a later slice; until it lands, both return the
// canonical typed error `{ error: "deep_memory_unavailable" }` — the SAME
// string the mobile/web client maps (T14), so the degraded surface reads
// identically everywhere. The family scope may also be absent in S1
// (`storeFor("family")` → null); a family write against it returns
// `{ error: "family_scope_unavailable" }`.
//
// NO memory content is ever logged — only ids, scopes, targets (paths), and
// line/char counts (logging rule). The store already scans every write
// fail-closed; the tool's own pre-PDP scan is the UX optimisation that keeps a
// crafted note from ever reaching a confirm prompt.

import type { ImpactTier, UserRole } from "@sentient/protocol";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import { MEMORY_SLUG_RE } from "../memory/memory-file.js";
import type { MemoryConfig, MemoryStore, MemoryWriteUsage, TopicMeta, WriteResult } from "../memory/memory-store.js";
import type { scanContent } from "../security/injection-scanner.js";
import type { NativeToolRunner } from "./tool-broker.js";
import { capToolResult } from "./tool-result-cap.js";
import type { ToolDefinition, ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "memory", "memory-tools"]);

/** The four tool names, frozen — `phase-services` needs these to seed the
 *  `knownTools` set (a skill's `tools:` frontmatter may name a memory tool)
 *  BEFORE `buildMemoryTools` runs, so the const breaks the cycle. */
export const MEMORY_TOOL_NAMES = ["memory_list", "memory_read", "memory_write", "memory_recall"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

/** The two memory scopes a session may hold (spec §3.5, §9). `private` is always
 *  granted; `family` is the shared household scope, granted to every member. */
export type MemoryScope = "private" | "family";
const SCOPES: readonly MemoryScope[] = ["private", "family"];
const DEFAULT_WRITE_SCOPE: MemoryScope = "private";

const READ_TIER: ImpactTier = "read";
const WRITE_TIER: ImpactTier = "write";

/** Roles that may write the SHARED family scope (spec §4.4: "requires an adult
 *  role"). `child` holds the `write` tier for its OWN private memory but never
 *  reaches the household scope, which is why this is an explicit set and not a
 *  tier check. */
const ADULT_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(["admin", "adult"]);

function isAdultRole(role: UserRole): boolean {
  return ADULT_ROLES.has(role);
}

/** Canonical typed-error codes. `deep_memory_unavailable` and
 *  `family_scope_unavailable` are client-mapped (T14) — same string everywhere;
 *  the `str_replace_*` / `remove_lines_*` codes are the pinned op-failure
 *  vocabulary (task brief). */
const ERR_DEEP_MEMORY_UNAVAILABLE = "deep_memory_unavailable";
const ERR_FAMILY_SCOPE_UNAVAILABLE = "family_scope_unavailable";
const ERR_STR_REPLACE_AMBIGUOUS = "str_replace_ambiguous";
const ERR_STR_REPLACE_NOT_FOUND = "str_replace_not_found";
const ERR_REMOVE_LINES_NOT_FOUND = "remove_lines_not_found";

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

/** A machine-readable typed error the model relays and the client maps. The
 *  `error` field is the canonical code; an optional `message` gives the model
 *  something to act on without changing what the client matches. */
function typedError(code: string, message?: string): ToolResult {
  return fail(JSON.stringify(message ? { error: code, message } : { error: code }));
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" ? value : null;
}

/** `undefined` = absent (default applies); `"invalid"` = present but not a
 *  known scope literal. */
function parseScope(args: Record<string, unknown>): MemoryScope | undefined | "invalid" {
  const value = args.scope;
  if (value === undefined || value === null) return undefined;
  if (value === "private" || value === "family") return value;
  return "invalid";
}

type FileTarget = { kind: "core" } | { kind: "topic"; slug: string } | { kind: "journal"; date: string };

const CORE_FILENAME = "MEMORY.md";
const TOPICS_PREFIX = "topics/";
const JOURNAL_PREFIX = "journal/";
const JOURNAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a `memory_read` file string into a typed file target, rejecting a
 *  traversal-shaped slug/date by construction (the slug/date regexes do the
 *  path check, mirroring the store). Returns null for an unrecognised file. */
function parseFileTarget(file: string): FileTarget | null {
  if (file === CORE_FILENAME) return { kind: "core" };
  if (file.startsWith(TOPICS_PREFIX)) {
    const slug = file.slice(TOPICS_PREFIX.length);
    return MEMORY_SLUG_RE.test(slug) ? { kind: "topic", slug } : null;
  }
  if (file.startsWith(JOURNAL_PREFIX)) {
    const date = file.slice(JOURNAL_PREFIX.length);
    return JOURNAL_DATE_RE.test(date) ? { kind: "journal", date } : null;
  }
  return null;
}

/** A `memory_write` target — only `MEMORY.md` and topic files are writable
 *  (journals are dreamer-owned, spec §8). */
type WriteTargetSpec = { kind: "core" } | { kind: "topic"; slug: string };

function parseWriteTarget(target: string): WriteTargetSpec | null {
  if (target === CORE_FILENAME) return { kind: "core" };
  if (target.startsWith(TOPICS_PREFIX)) {
    const slug = target.slice(TOPICS_PREFIX.length);
    return MEMORY_SLUG_RE.test(slug) ? { kind: "topic", slug } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write-time scan (pre-PDP)
// ---------------------------------------------------------------------------

/** Scans the model-provided write `content` fail-closed (spec §3.1: write-time
 *  scan fail-closed on suspicious AND hostile), BEFORE the PDP so a crafted
 *  note never reaches a confirm prompt. The store re-scans the full assembled
 *  document as the real boundary; this is the cheap UX gate on the new text. */
function scanWriteContent(scan: typeof scanContent, content: string, source: string): ToolResult | null {
  const result = scan(content, { channel: "memory_body", source });
  if (result.maxSeverity !== "suspicious" && result.maxSeverity !== "hostile") return null;
  const worst = result.findings.find((f) => f.severity === result.maxSeverity) ?? result.findings[0];
  const category = worst?.category ?? "prompt_injection";
  log.warn("memory-tools.scan.rejected", {
    source,
    maxSeverity: result.maxSeverity,
    category,
    reason: "write content matched a prompt-injection pattern — refused, nothing written",
  });
  return fail(`That text looks like a prompt-injection pattern (${category}); rephrase it and try again.`);
}

// ---------------------------------------------------------------------------
// Write-target accessor (core vs topic, one op path over both)
// ---------------------------------------------------------------------------

interface WriteTarget {
  read(): string;
  write(next: string): WriteResult;
  maxLines: number;
  maxChars: number;
  label: string;
}

function coreTarget(store: MemoryStore, cfg: MemoryConfig): WriteTarget {
  return {
    read: () => store.readCore() ?? "",
    write: (next) => store.writeCore(next),
    maxLines: cfg.core_max_lines,
    maxChars: cfg.core_max_chars,
    label: CORE_FILENAME,
  };
}

function topicTarget(store: MemoryStore, cfg: MemoryConfig, slug: string): WriteTarget {
  // Preserve an existing topic's frontmatter (name/description); a new topic
  // (append to an unused slug, spec §4.4) is created with the slug as its name
  // and an empty description the dreamer/model can fill later. Existing topics
  // are matched by frontmatter `name === slug` — the invariant every topic this
  // tool and the dreamer write upholds.
  const existing: TopicMeta | undefined = store.listTopics().find((m) => m.name === slug);
  const meta: TopicMeta = existing ?? { name: slug, description: "" };
  return {
    read: () => store.readTopic(slug) ?? "",
    write: (next) => store.writeTopic(slug, meta, next),
    maxLines: cfg.topic_max_lines,
    maxChars: cfg.topic_max_chars,
    label: `${TOPICS_PREFIX}${slug}`,
  };
}

// ---------------------------------------------------------------------------
// Op application (pure text transforms; typed error on failure)
// ---------------------------------------------------------------------------

type OpResult = { ok: true; text: string } | { ok: false; error: string };

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

function applyAppend(current: string, content: string): OpResult {
  const text = current.length === 0 ? content : `${current}\n${content}`;
  return { ok: true, text };
}

function applyStrReplace(current: string, oldStr: string, content: string): OpResult {
  const count = countOccurrences(current, oldStr);
  if (count === 0) return { ok: false, error: ERR_STR_REPLACE_NOT_FOUND };
  if (count > 1) return { ok: false, error: ERR_STR_REPLACE_AMBIGUOUS };
  return { ok: true, text: current.replace(oldStr, content) };
}

function applyRemoveLines(current: string, start: number, end: number): OpResult {
  const lines = current.split("\n");
  if (start < 1 || end < start || end > lines.length) {
    return { ok: false, error: ERR_REMOVE_LINES_NOT_FOUND };
  }
  lines.splice(start - 1, end - start + 1);
  return { ok: true, text: lines.join("\n") };
}

/** A parsed, structurally-valid write op. `str_replace`'s `oldStr` is
 *  guaranteed non-empty; `remove_lines`'s range is a validated `[start, end]`. */
type ParsedOp =
  | { op: "append"; content: string }
  | { op: "str_replace"; oldStr: string; content: string }
  | { op: "remove_lines"; start: number; end: number };

type OpParse = { ok: true; value: ParsedOp } | { ok: false; message: string };

function parseLines(args: Record<string, unknown>): [number, number] | null {
  const value = args.lines;
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return [start, end];
}

function parseOp(args: Record<string, unknown>): OpParse {
  const op = stringArg(args, "op");
  if (op === "append") {
    const content = stringArg(args, "content");
    if (content === null) return { ok: false, message: "append requires a string { content }." };
    return { ok: true, value: { op: "append", content } };
  }
  if (op === "str_replace") {
    const oldStr = stringArg(args, "old_str");
    const content = stringArg(args, "content");
    if (oldStr === null || oldStr.length === 0) {
      return { ok: false, message: "str_replace requires a non-empty string { old_str }." };
    }
    if (content === null) return { ok: false, message: "str_replace requires a string { content } to substitute." };
    return { ok: true, value: { op: "str_replace", oldStr, content } };
  }
  if (op === "remove_lines") {
    const lines = parseLines(args);
    if (lines === null) {
      return {
        ok: false,
        message: "remove_lines requires { lines: [start, end] } as two 1-based integer line numbers.",
      };
    }
    return { ok: true, value: { op: "remove_lines", start: lines[0], end: lines[1] } };
  }
  return { ok: false, message: 'memory_write requires { op } to be "append", "str_replace", or "remove_lines".' };
}

function applyOp(current: string, parsed: ParsedOp): OpResult {
  switch (parsed.op) {
    case "append":
      return applyAppend(current, parsed.content);
    case "str_replace":
      return applyStrReplace(current, parsed.oldStr, parsed.content);
    case "remove_lines":
      return applyRemoveLines(current, parsed.start, parsed.end);
  }
}

/** The new text a validated op would produce, or a typed op error. Kept
 *  separate from the store write so `validate` can scan the content and `run`
 *  can reuse the exact same transform. */
function opContentToScan(parsed: ParsedOp): string {
  return parsed.op === "remove_lines" ? "" : parsed.content;
}

// ---------------------------------------------------------------------------
// Store-outcome mapping
// ---------------------------------------------------------------------------

/** Renders the cap-usage line every write reports (spec §4.3). */
function usageReport(label: string, usage: MemoryWriteUsage, maxLines: number, maxChars: number): string {
  return `Saved to ${label} — now ${usage.lines}/${maxLines} lines, ${usage.chars}/${maxChars} chars.`;
}

function mapWriteResult(result: WriteResult, target: WriteTarget, scope: MemoryScope): ToolResult {
  if (result.ok) {
    log.info("memory-tools.write.ok", {
      scope,
      target: target.label,
      lines: result.usage.lines,
      chars: result.usage.chars,
    });
    return ok(usageReport(target.label, result.usage, target.maxLines, target.maxChars));
  }
  if (result.error === "cap_lines" || result.error === "cap_chars") {
    // The LOG carries the generic `reason=cap`; the RESULT carries the granular
    // kind (cap_lines vs cap_chars) so the model knows which dimension to trim.
    log.warn("memory-tools.write.refused", {
      scope,
      target: target.label,
      reason: "cap",
      kind: result.error,
      lines: result.usage?.lines,
      chars: result.usage?.chars,
    });
    const detail =
      result.error === "cap_lines"
        ? `${result.usage?.lines}/${target.maxLines} lines`
        : `${result.usage?.chars}/${target.maxChars} chars`;
    return typedError(
      result.error,
      `That write would exceed the ${target.label} cap (${detail}). Consolidate — rewrite, merge, or move detail to a topic file — and try again.`,
    );
  }
  if (result.error === "scan_rejected") {
    log.warn("memory-tools.scan.rejected", {
      scope,
      target: target.label,
      reason: "assembled document matched a prompt-injection pattern at write time — nothing written",
    });
    return fail("That write looks like a prompt-injection pattern; rephrase it and try again.");
  }
  // path_refused
  log.warn("memory-tools.write.refused", { scope, target: target.label, reason: "path" });
  return fail(`The memory target "${target.label}" is blocked on this device.`);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SCOPE_PROPERTY = {
  type: "string",
  enum: ["private", "family"],
  description:
    'Which memory to use: "private" (yours) or "family" (shared household). Writing family requires an adult.',
} as const;

function definitionFor(
  name: MemoryToolName,
  tier: ImpactTier,
  description: string,
  parameters: Record<string, unknown>,
): ToolDefinition {
  return { name, description, parameters, category: "foreground", tier };
}

const memoryListDefinition = definitionFor(
  "memory_list",
  READ_TIER,
  "List what you remember: the topic index (name — description) and journal dates, per scope. Consult this to see which memory files exist before reading or writing one.",
  {
    type: "object",
    properties: { scope: SCOPE_PROPERTY },
    additionalProperties: false,
  },
);

const memoryReadDefinition = definitionFor(
  "memory_read",
  READ_TIER,
  'Read a memory file in full (head-and-tail capped). Target a note file with {file: "MEMORY.md" | "topics/<slug>" | "journal/<date>"}, or a past conversation with {sessionId} from memory_recall.',
  {
    type: "object",
    properties: {
      scope: SCOPE_PROPERTY,
      target: {
        type: "object",
        description: "Either a note file or a past-session drill-down.",
        properties: {
          file: { type: "string", description: '"MEMORY.md", "topics/<slug>", or "journal/<date>".' },
          sessionId: { type: "string", description: "A past session id from a memory_recall hit (deep memory)." },
          around: { type: "number", description: "Entry sequence to center a session excerpt on (optional)." },
          offset: { type: "number", description: "Continuation offset into a session excerpt (optional)." },
        },
      },
    },
    required: ["target"],
    additionalProperties: false,
  },
);

const memoryWriteDefinition = definitionFor(
  "memory_write",
  WRITE_TIER,
  "Edit note memory. Choose a target (MEMORY.md or topics/<slug>) and an op: append (add text; a new slug creates the topic), str_replace (replace one unique passage), or remove_lines (delete a 1-based [start, end] range). Do not write ambiently — save clearly durable facts and things the user asks you to remember.",
  {
    type: "object",
    properties: {
      scope: SCOPE_PROPERTY,
      target: { type: "string", description: '"MEMORY.md" or "topics/<slug>".' },
      op: { type: "string", enum: ["append", "str_replace", "remove_lines"], description: "The edit operation." },
      content: { type: "string", description: "Text to append, or the substitute for str_replace." },
      old_str: { type: "string", description: "For str_replace: the exact unique passage to replace." },
      lines: {
        type: "array",
        items: { type: "number" },
        description: "For remove_lines: [start, end], 1-based inclusive.",
      },
    },
    required: ["target", "op"],
    additionalProperties: false,
  },
);

const memoryRecallDefinition = definitionFor(
  "memory_recall",
  READ_TIER,
  'Search back through past conversations for something not in your notes (deep, associative recall). This takes a few SECONDS — first say a brief out-loud acknowledgment like "let me think back…" so the pause is covered, then call it. Returns a compact list of hits; drill into one with memory_read {sessionId}.',
  {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for, in natural language." },
      timeRange: {
        type: "object",
        description: "Optional time window to bound the search.",
        properties: { from: { type: "string" }, to: { type: "string" } },
      },
      scope: SCOPE_PROPERTY,
      includeHistorical: {
        type: "boolean",
        description: "Include superseded/stale memories, labeled (default false).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
);

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface MemoryToolsDeps {
  /** Resolves the store for a scope, or null when that scope is not granted /
   *  not yet available (family in S1). */
  storeFor(scope: MemoryScope): MemoryStore | null;
  /** The injection scanner (T3b) — injected so the module stays a pure consumer
   *  of the security surface and the scan is observable in a test. */
  scan: typeof scanContent;
  /** `orchestrator.memory` — caps + `read_max_chars` for the read page. */
  cfg: MemoryConfig;
  /** The session owner (L0). Only the ROLE is read, and only for the
   *  family-scope adult gate; authority still flows through the broker's
   *  capability, never this value. */
  principal: UserPrincipal;
}

// ---------------------------------------------------------------------------
// Settings projection meta (mcp-catalog.ts)
// ---------------------------------------------------------------------------

export interface MemoryToolSettingsMeta {
  readonly name: MemoryToolName;
  readonly description: string;
  readonly tier: ImpactTier;
}

/** HUMAN-facing settings copy — separate from each definition's MODEL-facing
 *  description. Projected under `"native"` with `settable: true` by
 *  `mcp-catalog.ts`'s `projectNativeTools`, role-gated like the skill tools
 *  (the `write`-tier editor reaches adult+; the read tools reach every role). */
export const MEMORY_TOOL_SETTINGS: readonly MemoryToolSettingsMeta[] = [
  { name: "memory_list", description: "Let the assistant see what it remembers about you.", tier: READ_TIER },
  { name: "memory_read", description: "Let the assistant read its saved memory in detail.", tier: READ_TIER },
  { name: "memory_write", description: "Let the assistant save and update what it remembers.", tier: WRITE_TIER },
  { name: "memory_recall", description: "Let the assistant search back through past conversations.", tier: READ_TIER },
];

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function renderScopeBlock(store: MemoryStore, scope: MemoryScope): string {
  const core = store.readCore();
  const coreLine = core === null ? "MEMORY.md: (empty)" : `MEMORY.md: ${core.split("\n").length} lines`;
  const topics = store.listTopics();
  const topicLines =
    topics.length === 0
      ? "Topics: (none)"
      : ["Topics:", ...topics.map((t) => `  ${t.name} — ${t.description}`)].join("\n");
  const journal = store.listJournal();
  const journalLine = journal.length === 0 ? "Journal dates: (none)" : `Journal dates: ${journal.join(", ")}`;
  return [`[${scope}]`, coreLine, topicLines, journalLine].join("\n");
}

function createMemoryListRunner(deps: MemoryToolsDeps): NativeToolRunner {
  return {
    definition: memoryListDefinition,
    validate(args) {
      if (parseScope(args) === "invalid") return fail('memory_list { scope } must be "private" or "family".');
      return null;
    },
    async run(args): Promise<ToolResult> {
      const scopeArg = parseScope(args);
      const targetScopes = scopeArg && scopeArg !== "invalid" ? [scopeArg] : SCOPES;
      const blocks: string[] = [];
      for (const scope of targetScopes) {
        const store = deps.storeFor(scope);
        if (store === null) {
          // An explicitly-requested absent scope is an error; an absent scope
          // under the default (both) is simply skipped.
          if (scopeArg === scope) return typedError(ERR_FAMILY_SCOPE_UNAVAILABLE);
          continue;
        }
        blocks.push(renderScopeBlock(store, scope));
      }
      if (blocks.length === 0) return ok("You have no memory saved yet.");
      log.info("memory-tools.list", { scopes: targetScopes.join(",") });
      return ok(blocks.join("\n\n"));
    },
  };
}

/** Reads the store for a file target, or null when the file is absent. */
function readFileTarget(store: MemoryStore, target: FileTarget): string | null {
  switch (target.kind) {
    case "core":
      return store.readCore();
    case "topic":
      return store.readTopic(target.slug);
    case "journal":
      return store.readJournal(target.date);
  }
}

function createMemoryReadRunner(deps: MemoryToolsDeps): NativeToolRunner {
  return {
    definition: memoryReadDefinition,
    validate(args) {
      if (parseScope(args) === "invalid") return fail('memory_read { scope } must be "private" or "family".');
      const target = args.target;
      if (typeof target !== "object" || target === null) {
        return fail("memory_read requires a { target } object.");
      }
      const t = target as Record<string, unknown>;
      const hasFile = typeof t.file === "string";
      const hasSession = typeof t.sessionId === "string";
      if (!hasFile && !hasSession) {
        return fail('memory_read { target } needs a "file" or a "sessionId".');
      }
      return null;
    },
    async run(args): Promise<ToolResult> {
      const scopeArg = parseScope(args);
      const scope: MemoryScope = scopeArg && scopeArg !== "invalid" ? scopeArg : DEFAULT_WRITE_SCOPE;
      const target = args.target as Record<string, unknown>;

      // Session drill-down is deep memory — unavailable in S1.
      if (typeof target.sessionId === "string") {
        log.info("memory-tools.read.deep-unavailable", { scope });
        return typedError(ERR_DEEP_MEMORY_UNAVAILABLE);
      }

      const store = deps.storeFor(scope);
      if (store === null) return typedError(ERR_FAMILY_SCOPE_UNAVAILABLE);

      const file = typeof target.file === "string" ? target.file : null;
      if (file === null) return fail('memory_read { target } needs a "file" or a "sessionId".');
      const fileTarget = parseFileTarget(file);
      if (fileTarget === null) {
        return fail('memory_read { target.file } must be "MEMORY.md", "topics/<slug>", or "journal/<date>".');
      }

      const body = readFileTarget(store, fileTarget);
      if (body === null) return fail(`No ${file} found in ${scope} memory.`);

      const capped = capToolResult(body, { limit: deps.cfg.read_max_chars });
      log.info("memory-tools.read.ok", { scope, file, chars: body.length });
      return ok(capped);
    },
  };
}

/** The shared structural parse for `memory_write` — scope, target, op — reused
 *  by both `validate` and `run`. Family-role and scan checks layer on top. */
type WriteParse =
  | { ok: true; scope: MemoryScope; target: WriteTargetSpec; parsed: ParsedOp }
  | { ok: false; result: ToolResult };

function parseWrite(args: Record<string, unknown>): WriteParse {
  const scopeArg = parseScope(args);
  if (scopeArg === "invalid")
    return { ok: false, result: fail('memory_write { scope } must be "private" or "family".') };
  const scope: MemoryScope = scopeArg ?? DEFAULT_WRITE_SCOPE;

  const targetStr = stringArg(args, "target");
  if (targetStr === null) return { ok: false, result: fail("memory_write requires a string { target }.") };
  const target = parseWriteTarget(targetStr);
  if (target === null) {
    return { ok: false, result: fail('memory_write { target } must be "MEMORY.md" or "topics/<slug>".') };
  }

  const opParse = parseOp(args);
  if (!opParse.ok) return { ok: false, result: fail(opParse.message) };

  return { ok: true, scope, target: target, parsed: opParse.value };
}

function writeTargetFor(store: MemoryStore, cfg: MemoryConfig, spec: WriteTargetSpec): WriteTarget {
  return spec.kind === "core" ? coreTarget(store, cfg) : topicTarget(store, cfg, spec.slug);
}

function createMemoryWriteRunner(deps: MemoryToolsDeps): NativeToolRunner {
  return {
    definition: memoryWriteDefinition,
    validate(args) {
      const parse = parseWrite(args);
      if (!parse.ok) return parse.result;
      // Family-scope ROLE gate — BEFORE the PDP (spec §4.4). A child holds the
      // write tier for its own memory but may never edit the shared household
      // scope, so this is an explicit role check, not a tier check.
      if (parse.scope === "family" && !isAdultRole(deps.principal.role)) {
        log.warn("memory-tools.write.role-refused", {
          scope: parse.scope,
          role: deps.principal.role,
          reason: "family-scope write requires an adult role — refused before the PDP",
        });
        return fail("Family memory can only be changed by an adult in this household.");
      }
      const content = opContentToScan(parse.parsed);
      if (content.length > 0) {
        const scanned = scanWriteContent(
          deps.scan,
          content,
          parse.target.kind === "core" ? CORE_FILENAME : parse.target.slug,
        );
        if (scanned) return scanned;
      }
      return null;
    },
    async run(args): Promise<ToolResult> {
      const parse = parseWrite(args);
      if (!parse.ok) return parse.result;
      if (parse.scope === "family" && !isAdultRole(deps.principal.role)) {
        return fail("Family memory can only be changed by an adult in this household.");
      }

      const store = deps.storeFor(parse.scope);
      if (store === null) return typedError(ERR_FAMILY_SCOPE_UNAVAILABLE);

      const content = opContentToScan(parse.parsed);
      if (content.length > 0) {
        const scanned = scanWriteContent(
          deps.scan,
          content,
          parse.target.kind === "core" ? CORE_FILENAME : parse.target.slug,
        );
        if (scanned) return scanned;
      }

      const target = writeTargetFor(store, deps.cfg, parse.target);
      const applied = applyOp(target.read(), parse.parsed);
      if (!applied.ok) {
        log.info("memory-tools.write.op-error", { scope: parse.scope, target: target.label, error: applied.error });
        return typedError(applied.error);
      }
      return mapWriteResult(target.write(applied.text), target, parse.scope);
    },
  };
}

function createMemoryRecallRunner(deps: MemoryToolsDeps): NativeToolRunner {
  return {
    definition: memoryRecallDefinition,
    validate(args) {
      const query = stringArg(args, "query");
      if (query === null || query.trim().length === 0)
        return fail("memory_recall requires a non-empty string { query }.");
      if (parseScope(args) === "invalid") return fail('memory_recall { scope } must be "private" or "family".');
      return null;
    },
    async run(args): Promise<ToolResult> {
      // Deep memory (DeepMemoryService) is not wired in S1 — the honest,
      // client-mapped degraded answer (spec §10). `deps` is read for parity
      // with the other runners; the scope only annotates the log.
      void deps;
      const scopeArg = parseScope(args);
      const scope = scopeArg && scopeArg !== "invalid" ? scopeArg : "both";
      log.warn("memory-tools.recall.unavailable", {
        scope,
        reason: ERR_DEEP_MEMORY_UNAVAILABLE,
      });
      return typedError(ERR_DEEP_MEMORY_UNAVAILABLE);
    },
  };
}

/** Builds the four memory-tool runners for ONE session's scopes, ready to hand
 *  to `ToolBrokerDeps.nativeTools` (merged with the skill tools). */
export function buildMemoryTools(deps: MemoryToolsDeps): NativeToolRunner[] {
  return [
    createMemoryListRunner(deps),
    createMemoryReadRunner(deps),
    createMemoryWriteRunner(deps),
    createMemoryRecallRunner(deps),
  ];
}
