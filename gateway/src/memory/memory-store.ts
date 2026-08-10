// Capability-rooted filesystem store for per-scope file memory (Memory System
// spec §4, §3.2). Layout under `<cap.rootPath>/memory/`:
//
//   MEMORY.md              core notes (bare markdown)
//   topics/<slug>.md       overflow topic notes (frontmatter + body)
//   journal/<date>.md      dreamer-written day narrative + op log
//   archive/MEMORY-*.md    timestamped MEMORY.md snapshots
//   .ingest-state.json     content hashes + quarantine flags (this module owns it)
//
// This file owns only the filesystem surface: the wrong-class capability
// rejection, the symlink-escape guard (skill-store.ts:85-97 precedent —
// `capabilityCoversPath` is LEXICAL, which is why the realpath guard is
// rebuilt here), atomic tmp+rename writes, write-time cap + scan gating, and
// edit-ingest quarantine. Format parsing / cap counting is delegated to
// `memory-file.ts` (T3a).
//
// Scan-gate severity is PER-SURFACE (spec §3.2/§3.3): core + topic files render
// straight into the system prompt with no read-time gate, so their writes
// fail-closed on `suspicious` AND `hostile`. Journal files never render into a
// prompt — their content reaches model context exclusively via the deep-memory
// index → spark/`memory_recall` → inbound gate (`memory_body`) re-screening with
// RiskAccumulator escalation (a SECOND gate), so a journal write fails-closed on
// `hostile` ONLY; a `suspicious` verdict is annotated (WARN, counts/categories
// only) and written. Taint provenance still marks tool-derived episodes. The
// same split governs edit-ingest re-scan (`isContentClean`).
//
// The store owns `mkdir` lazily at write time — the grant (T2) is pure and
// creates nothing, mirroring the FileScope precedent. A rejected write
// (cap / scan) never touches the filesystem.
//
// Never throws from a read/write op: every failable path returns a typed
// result or `null` (error-handling rule) so one malformed memory file cannot
// crash a caller mid-loop. The ONE deliberate throw is the wrong-class
// capability rejection at open — a programming error, surfaced loudly.

import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { OrchestratorConfig } from "@sentient/config";
import type { Capability, ResourceClass } from "../access/capability.js";
import { getLog } from "../logging/logger.js";
import type { ScanResult, scanContent } from "../security/injection-scanner.js";
import {
  MEMORY_SLUG_RE,
  type TopicFile,
  countUsage,
  parseTopicFile,
  serializeTopicFile,
  validateMemoryText,
} from "./memory-file.js";

const log = getLog(["sentient", "memory", "store"]);

/** The `orchestrator.memory` config block (shared/config). Consumed for the
 *  core/topic dual caps; the store is a pure consumer of this shape. */
export type MemoryConfig = OrchestratorConfig["memory"];

/** Resource classes this store accepts. Every other class is rejected FIRST,
 *  before any path logic runs. */
const ACCEPTED_CLASSES: ReadonlySet<ResourceClass> = new Set<ResourceClass>(["memory-private", "memory-household"]);

const MEMORY_DIRNAME = "memory";
const CORE_FILENAME = "MEMORY.md";
const TOPICS_DIRNAME = "topics";
const JOURNAL_DIRNAME = "journal";
const ARCHIVE_DIRNAME = "archive";
const INGEST_STATE_FILENAME = ".ingest-state.json";
const MD_EXT = ".md";

/** `YYYY-MM-DD` — journal filename shape. Rejecting anything else by
 *  construction is what makes a traversal-shaped date (`../../etc`) fail this
 *  regex rather than needing a separate path check (MEMORY_SLUG_RE plays the
 *  same role for topic slugs). */
const JOURNAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fail-closed severities for PROMPT-RENDERED surfaces (core + topic) — a write
 *  is refused when the scan's max severity is at or above `suspicious`
 *  (skill-tools `injectionScanError` precedent). These files render into the
 *  system prompt with no read-time gate, so the write is the only gate. */
function isScanRejected(result: ScanResult): boolean {
  return result.maxSeverity === "suspicious" || result.maxSeverity === "hostile";
}

/** Fail-closed severity for the JOURNAL surface — refused only at `hostile`. A
 *  `suspicious` verdict is annotated and written: journal content transits the
 *  inbound `memory_body` gate on every read-time path (spec §3.2/§3.3), so it is
 *  re-screened downstream, unlike the prompt-rendered core/topic files. */
function isJournalScanRejected(result: ScanResult): boolean {
  return result.maxSeverity === "hostile";
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Topic index entry — the `name — description` pair rendered into the prompt
 *  topic index (spec §4.5) and returned to `memory_list` (T5). `name` is the
 *  slug (MEMORY_SLUG_RE-validated by `parseTopicFile`). */
export interface TopicMeta {
  name: string;
  description: string;
}

/** Line/char usage as reported in every `memory_write` result (spec §4.3). */
export interface MemoryWriteUsage {
  lines: number;
  chars: number;
}

export type WriteResult =
  | { ok: true; usage: MemoryWriteUsage }
  | {
      ok: false;
      error: "cap_lines" | "cap_chars" | "scan_rejected" | "path_refused";
      usage?: MemoryWriteUsage;
    };

export interface MemoryStore {
  readCore(): string | null;
  writeCore(next: string): WriteResult;
  listTopics(): TopicMeta[];
  readTopic(slug: string): string | null;
  writeTopic(slug: string, meta: TopicMeta, body: string): WriteResult;
  listJournal(): string[];
  readJournal(date: string): string | null;
  writeJournal(date: string, content: string): WriteResult;
  archiveCore(): void;
  /** Hash-detect out-of-band edits, re-validate + re-scan the changed files.
   *  A changed file that fails is quarantined (rendered absent from
   *  readCore/readTopic/list* until re-written through the store); a changed
   *  file that passes has its recorded hash refreshed and any prior quarantine
   *  cleared. Unchanged files are untouched. */
  reingestEdits(): { rescanned: string[]; quarantined: string[] };
}

export interface MemoryStoreDeps {
  scan: typeof scanContent;
}

// ---------------------------------------------------------------------------
// Ingest state (content hashes + quarantine flags)
// ---------------------------------------------------------------------------

interface IngestEntry {
  hash: string;
  quarantined: boolean;
}

/** relPath (`MEMORY.md`, `topics/<slug>.md`, `journal/<date>.md`) → entry. */
type IngestState = Record<string, IngestEntry>;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Opens a memory store rooted at `<cap.rootPath>/memory`. Throws immediately
 * (before any path logic) if the capability is not `memory-private` or
 * `memory-household` — a confused-deputy handoff of the wrong grant is a
 * programming error, not a recoverable condition.
 */
export function openMemoryStore(cap: Capability, cfg: MemoryConfig, deps: MemoryStoreDeps): MemoryStore {
  if (!ACCEPTED_CLASSES.has(cap.resource)) {
    // Loud by design (contrast with the never-throw read/write ops below):
    // the caller minted or routed the wrong resource class.
    throw new Error(
      `openMemoryStore: wrong resource class "${cap.resource}" — expected memory-private or memory-household`,
    );
  }

  const memoryRoot = join(cap.rootPath, MEMORY_DIRNAME);
  const ingestStatePath = join(memoryRoot, INGEST_STATE_FILENAME);

  const corePath = (): string => join(memoryRoot, CORE_FILENAME);
  const topicPath = (slug: string): string => join(memoryRoot, TOPICS_DIRNAME, `${slug}${MD_EXT}`);
  const journalPath = (date: string): string => join(memoryRoot, JOURNAL_DIRNAME, `${date}${MD_EXT}`);

  const coreRel = CORE_FILENAME;
  const topicRel = (slug: string): string => `${TOPICS_DIRNAME}/${slug}${MD_EXT}`;
  const journalRel = (date: string): string => `${JOURNAL_DIRNAME}/${date}${MD_EXT}`;

  // -- symlink guard ---------------------------------------------------------

  function realpathOrNull(p: string): string | null {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  }

  function isWithin(child: string, root: string): boolean {
    return child === root || child.startsWith(root + sep);
  }

  /** Resolves `filePath` and confirms it sits inside the realpath'd memory
   *  root. Returns the realpath, or null when the file is absent (ordinary
   *  "no such file") or escapes the root via a symlink (WARN — refused, never
   *  followed; spec §3.2). Used by every READ path. */
  function guardedReadReal(filePath: string, relPath: string): string | null {
    const realRoot = realpathOrNull(memoryRoot);
    if (realRoot === null) return null; // no memory dir yet — nothing to read
    const real = realpathOrNull(filePath);
    if (real === null) return null;
    if (!isWithin(real, realRoot)) {
      log.warn("store.symlink-refused", { relPath, op: "read" });
      return null;
    }
    return real;
  }

  /**
   * Prepares a write target: lazily creates the containing dir tree, then
   * confirms both the (realpath'd) containing dir AND any pre-existing target
   * file sit inside the realpath'd memory root. Returns the realpath'd file to
   * write, or null when the path escapes via a symlink (WARN — refused, never
   * followed, matching skill-store's unconditional path refusal).
   */
  function resolveWriteTarget(filePath: string, relPath: string): string | null {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    const realRoot = realpathSync(memoryRoot); // exists now — we just mkdir'd under it
    const realDir = realpathSync(dir);
    if (!isWithin(realDir, realRoot)) {
      log.warn("store.symlink-refused", { relPath, op: "write" });
      return null;
    }

    const target = join(realDir, basename(filePath));
    // A pre-existing target that is itself a symlink escaping the root must be
    // refused, never followed (writing through it would land outside the grant).
    if (existsSync(target)) {
      const realTarget = realpathOrNull(target);
      if (realTarget !== null && !isWithin(realTarget, realRoot)) {
        log.warn("store.symlink-refused", { relPath, op: "write" });
        return null;
      }
    }
    return target;
  }

  function atomicWrite(realTarget: string, content: string): void {
    const tmpPath = join(dirname(realTarget), `.${basename(realTarget)}.tmp-${randomUUID()}`);
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, realTarget);
  }

  // -- ingest state ----------------------------------------------------------

  function loadIngestState(): IngestState {
    let raw: string;
    try {
      raw = readFileSync(ingestStatePath, "utf8");
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as IngestState;
      }
    } catch {
      log.warn("store.ingest-state.corrupt", { reason: "unparseable — starting empty" });
    }
    return {};
  }

  // In-memory mirror of `.ingest-state.json`. This store instance is the only
  // writer of that file (per-capability, single instance — the composition
  // precedent), so the mirror cannot drift out of sync with the on-disk copy.
  const ingestState: IngestState = loadIngestState();

  function persistIngestState(): void {
    mkdirSync(memoryRoot, { recursive: true });
    atomicWrite(ingestStatePath, JSON.stringify(ingestState, null, 2));
  }

  function isQuarantined(relPath: string): boolean {
    return ingestState[relPath]?.quarantined === true;
  }

  function recordClean(relPath: string, content: string): void {
    ingestState[relPath] = { hash: sha256(content), quarantined: false };
    persistIngestState();
  }

  // -- write gating (shared by core / topic) --------------------------------

  interface CapCheck {
    maxLines: number;
    maxChars: number;
  }

  /** Runs the dual line/char cap + invisible-char lint (T3a) over `text`.
   *  Returns a WriteResult error arm on failure, or null to proceed. An
   *  invisible-char rejection maps to `scan_rejected` — the WriteResult union
   *  has no dedicated arm for it, and it is a content-safety refusal in the
   *  same family as the scan. */
  function capError(text: string, caps: CapCheck): Extract<WriteResult, { ok: false }> | null {
    const result = validateMemoryText(text, { maxLines: caps.maxLines, maxChars: caps.maxChars });
    if (result.ok) return null;
    const usage: MemoryWriteUsage = { lines: result.lines, chars: result.chars };
    if (result.error === "cap_lines" || result.error === "cap_chars") {
      return { ok: false, error: result.error, usage };
    }
    // invisible_chars
    log.warn("store.write.invisible-chars", { lines: result.lines, chars: result.chars });
    return { ok: false, error: "scan_rejected", usage };
  }

  function scanCategories(result: ScanResult): string[] {
    return [...new Set(result.findings.map((f) => f.category))];
  }

  /** Runs the injection scan for a PROMPT-RENDERED surface (core/topic;
   *  fail-closed on suspicious/hostile). Returns a `scan_rejected` WriteResult
   *  on rejection, or null to proceed. */
  function scanError(
    scanText: string,
    relPath: string,
    usage: MemoryWriteUsage,
  ): Extract<WriteResult, { ok: false }> | null {
    const result = deps.scan(scanText, { channel: "memory_body", source: relPath });
    if (!isScanRejected(result)) return null;
    log.warn("store.write.scan-rejected", {
      relPath,
      maxSeverity: result.maxSeverity,
      categories: scanCategories(result),
    });
    return { ok: false, error: "scan_rejected", usage };
  }

  /** Journal-surface scan gate — fail-closed on `hostile` ONLY. A `suspicious`
   *  verdict is annotated (WARN, counts/categories only — never content) and the
   *  write proceeds, because journal content is re-screened at every read-time
   *  path by the inbound `memory_body` gate (spec §3.2/§3.3), unlike the
   *  prompt-rendered core/topic files. Returns a `scan_rejected` WriteResult on
   *  hostile, or null to proceed. */
  function journalScanError(
    content: string,
    relPath: string,
    usage: MemoryWriteUsage,
  ): Extract<WriteResult, { ok: false }> | null {
    const result = deps.scan(content, { channel: "memory_body", source: relPath });
    if (isJournalScanRejected(result)) {
      log.warn("store.write.scan-rejected", {
        relPath,
        maxSeverity: result.maxSeverity,
        categories: scanCategories(result),
      });
      return { ok: false, error: "scan_rejected", usage };
    }
    if (result.maxSeverity === "suspicious") {
      log.warn("memory-store.journal.suspicious", {
        relPath,
        maxSeverity: result.maxSeverity,
        categories: scanCategories(result),
        findings: result.findings.length,
      });
    }
    return null;
  }

  // -- re-ingest helpers -----------------------------------------------------

  /** True when `content` at `relPath` passes re-validation + re-scan. Mirrors
   *  the write-time gate: caps + invisible lint (core/topic), frontmatter
   *  parse (topic), and the fail-closed injection scan (all). */
  function isContentClean(relPath: string, content: string): boolean {
    if (relPath === coreRel) {
      if (capError(content, { maxLines: cfg.core_max_lines, maxChars: cfg.core_max_chars })) return false;
      return !isScanRejected(deps.scan(content, { channel: "memory_body", source: relPath }));
    }
    if (relPath.startsWith(`${TOPICS_DIRNAME}/`)) {
      const parsed = parseTopicFile(content);
      if (!parsed.ok) return false;
      if (capError(parsed.topic.body, { maxLines: cfg.topic_max_lines, maxChars: cfg.topic_max_chars })) return false;
      return !isScanRejected(deps.scan(topicScanText(parsed.topic), { channel: "memory_body", source: relPath }));
    }
    // journal — scan only (dreamer-authored; no config cap). Quarantine on
    // `hostile` ONLY; a `suspicious` re-ingest is annotated and kept, mirroring
    // the write-time journal gate (spec §3.2/§3.3 — read-time gate re-screens).
    const result = deps.scan(content, { channel: "memory_body", source: relPath });
    if (result.maxSeverity === "suspicious") {
      log.warn("memory-store.journal.suspicious", {
        relPath,
        maxSeverity: result.maxSeverity,
        categories: scanCategories(result),
        findings: result.findings.length,
      });
    }
    return !isJournalScanRejected(result);
  }

  function topicScanText(topic: { name: string; description: string; body: string }): string {
    return `${topic.name}\n${topic.description}\n${topic.body}`;
  }

  /** Relative paths of every content file currently on disk (core + topics +
   *  journal). Discovers human-added files too, so an out-of-band new file is
   *  scanned before it can render. */
  function walkContentFiles(): string[] {
    const rels: string[] = [];
    if (existsSync(corePath())) rels.push(coreRel);
    for (const name of listMdFiles(join(memoryRoot, TOPICS_DIRNAME))) {
      rels.push(`${TOPICS_DIRNAME}/${name}`);
    }
    for (const name of listMdFiles(join(memoryRoot, JOURNAL_DIRNAME))) {
      rels.push(`${JOURNAL_DIRNAME}/${name}`);
    }
    return rels;
  }

  function listMdFiles(dir: string): string[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isFile() && e.name.endsWith(MD_EXT)).map((e) => e.name);
  }

  // -------------------------------------------------------------------------
  // Public ops
  // -------------------------------------------------------------------------

  function writeGuarded(relPath: string, filePath: string, diskContent: string): WriteResult | "escaped" {
    const target = resolveWriteTarget(filePath, relPath);
    if (target === null) return "escaped";
    atomicWrite(target, diskContent);
    recordClean(relPath, diskContent);
    return { ok: true, usage: countUsage(diskContent) };
  }

  return {
    readCore(): string | null {
      if (isQuarantined(coreRel)) {
        log.debug("store.read.quarantined-absent", { relPath: coreRel });
        return null;
      }
      const real = guardedReadReal(corePath(), coreRel);
      if (real === null) return null;
      try {
        return readFileSync(real, "utf8");
      } catch {
        return null;
      }
    },

    writeCore(next: string): WriteResult {
      const cap = capError(next, { maxLines: cfg.core_max_lines, maxChars: cfg.core_max_chars });
      if (cap) return cap;
      const usage = countUsage(next);
      const scan = scanError(next, coreRel, usage);
      if (scan) return scan;

      const result = writeGuarded(coreRel, corePath(), next);
      if (result === "escaped") return { ok: false, error: "path_refused" };
      log.info("store.write.ok", { relPath: coreRel, lines: usage.lines, chars: usage.chars });
      return result;
    },

    listTopics(): TopicMeta[] {
      const metas: TopicMeta[] = [];
      for (const name of listMdFiles(join(memoryRoot, TOPICS_DIRNAME))) {
        const slug = basename(name, MD_EXT);
        const rel = topicRel(slug);
        if (isQuarantined(rel)) continue;
        const real = guardedReadReal(topicPath(slug), rel);
        if (real === null) continue;
        const topic = loadTopic(real);
        if (!topic) continue;
        metas.push({ name: topic.name, description: topic.description });
      }
      log.debug("store.list-topics", { count: metas.length });
      return metas;
    },

    readTopic(slug: string): string | null {
      if (!MEMORY_SLUG_RE.test(slug)) return null;
      const rel = topicRel(slug);
      if (isQuarantined(rel)) {
        log.debug("store.read.quarantined-absent", { relPath: rel });
        return null;
      }
      const real = guardedReadReal(topicPath(slug), rel);
      if (real === null) return null;
      const topic = loadTopic(real);
      return topic ? topic.body : null;
    },

    writeTopic(slug: string, meta: TopicMeta, body: string): WriteResult {
      if (!MEMORY_SLUG_RE.test(slug)) return { ok: false, error: "path_refused" };
      const cap = capError(body, { maxLines: cfg.topic_max_lines, maxChars: cfg.topic_max_chars });
      if (cap) return cap;
      const rel = topicRel(slug);
      const usage = countUsage(body);
      const scan = scanError(topicScanText({ name: meta.name, description: meta.description, body }), rel, usage);
      if (scan) return scan;

      const serialized = serializeTopicFile({ name: meta.name, description: meta.description }, body);
      const result = writeGuarded(rel, topicPath(slug), serialized);
      if (result === "escaped") return { ok: false, error: "path_refused" };
      log.info("store.write.ok", { relPath: rel, lines: usage.lines, chars: usage.chars });
      // Usage reported is the BODY's (the capped text), not the serialized file's.
      return { ok: true, usage };
    },

    listJournal(): string[] {
      const dates: string[] = [];
      for (const name of listMdFiles(join(memoryRoot, JOURNAL_DIRNAME))) {
        const date = basename(name, MD_EXT);
        if (!JOURNAL_DATE_RE.test(date)) continue;
        if (isQuarantined(journalRel(date))) continue;
        dates.push(date);
      }
      dates.sort();
      log.debug("store.list-journal", { count: dates.length });
      return dates;
    },

    readJournal(date: string): string | null {
      if (!JOURNAL_DATE_RE.test(date)) return null;
      const rel = journalRel(date);
      if (isQuarantined(rel)) {
        log.debug("store.read.quarantined-absent", { relPath: rel });
        return null;
      }
      const real = guardedReadReal(journalPath(date), rel);
      if (real === null) return null;
      try {
        return readFileSync(real, "utf8");
      } catch {
        return null;
      }
    },

    writeJournal(date: string, content: string): WriteResult {
      if (!JOURNAL_DATE_RE.test(date)) return { ok: false, error: "path_refused" };
      const rel = journalRel(date);
      const usage = countUsage(content);
      const scan = journalScanError(content, rel, usage);
      if (scan) return scan;

      const result = writeGuarded(rel, journalPath(date), content);
      if (result === "escaped") return { ok: false, error: "path_refused" };
      log.info("store.write.ok", { relPath: rel, lines: usage.lines, chars: usage.chars });
      return result;
    },

    archiveCore(): void {
      const real = guardedReadReal(corePath(), coreRel);
      if (real === null) return; // nothing to archive
      let content: string;
      try {
        content = readFileSync(real, "utf8");
      } catch {
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = join(memoryRoot, ARCHIVE_DIRNAME, `MEMORY-${stamp}${MD_EXT}`);
      const target = resolveWriteTarget(dest, `${ARCHIVE_DIRNAME}/MEMORY-${stamp}${MD_EXT}`);
      if (target === null) return;
      atomicWrite(target, content);
      log.info("store.archive.core", { chars: content.length });
    },

    reingestEdits(): { rescanned: string[]; quarantined: string[] } {
      const rescanned: string[] = [];
      const quarantined: string[] = [];

      const onDisk = new Set(walkContentFiles());
      let mutated = false;

      // Drop state entries whose file no longer exists on disk.
      for (const rel of Object.keys(ingestState)) {
        if (!onDisk.has(rel)) {
          delete ingestState[rel];
          mutated = true;
        }
      }

      for (const rel of onDisk) {
        const real = guardedReadReal(join(memoryRoot, rel), rel);
        if (real === null) continue; // symlink escape or vanished — skip
        let content: string;
        try {
          content = readFileSync(real, "utf8");
        } catch {
          continue;
        }
        const currentHash = sha256(content);
        const recorded = ingestState[rel];
        if (recorded && recorded.hash === currentHash) continue; // unchanged — leave as-is

        if (isContentClean(rel, content)) {
          ingestState[rel] = { hash: currentHash, quarantined: false };
          rescanned.push(rel);
        } else {
          ingestState[rel] = { hash: currentHash, quarantined: true };
          quarantined.push(rel);
          log.warn("store.reingest.quarantined", { relPath: rel });
        }
        mutated = true;
      }

      if (mutated) persistIngestState();
      log.debug("store.reingest", { rescanned: rescanned.length, quarantined: quarantined.length });
      return { rescanned, quarantined };
    },
  };

  /** Parse + slug-match a topic file from its realpath. Returns null on
   *  corruption (corrupt-skip, skill-store precedent) — one malformed topic
   *  never breaks list/read of the others. */
  function loadTopic(realPath: string): TopicFile | null {
    let raw: string;
    try {
      raw = readFileSync(realPath, "utf8");
    } catch {
      return null;
    }
    const result = parseTopicFile(raw);
    if (!result.ok) {
      log.warn("store.topic.skip", { reason: result.error.kind });
      return null;
    }
    return result.topic;
  }
}
