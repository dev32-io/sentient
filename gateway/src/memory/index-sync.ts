// Index-sync outbox — the durable queue between the file-memory layer and the
// DeepMemoryService (Memory System spec §5.6). File writes and dreamer outputs
// enqueue index work into a small per-scope sync cursor; sync runs on demand
// and on service-health recovery. A service outage therefore leaves a QUEUE,
// not permanent staleness: rows persist to disk and are replayed until the
// upsert lands.
//
// The queue lives in the scope's `deep-memory/.sync-cursor.json` — a SIBLING of
// `memory/`, never inside it (spec §2: the two dirs have asymmetric lifecycles;
// the derived index and its outbox can be blown away without touching the
// canonical notes). Written atomically (tmp + rename), same as the store.
//
// Idempotency is by construction: every entry id is deterministic —
// `hash(scope:kind:sourceRef:contentHash)` (spec §5.4). Re-feeding the same
// content converges (same id → upsert overwrites in place); `rebuildScope`
// drops the index then replays every source through this same path. Nothing
// here throws across the boundary: the client already returns typed Results and
// never throws, so a dead index engine defers work rather than crashing a
// caller mid-turn (degradation model, spec §10).
//
// No memory content in logs (global constraint): only counts, ids, kinds, and
// relative file paths are logged — never entry text.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ClientError, DeepMemoryClient, EntryAudience, IndexEntry, SourceRef } from "./deep-memory-client.js";
import { MEMORY_SLUG_RE } from "./memory-file.js";
import type { MemoryConfig, MemoryStore } from "./memory-store.js";

const log = getLog(["sentient", "memory", "index-sync"]);

// --- Constants ---------------------------------------------------------------

const CURSOR_FILENAME = ".sync-cursor.json";
const CURSOR_VERSION = 1;

const CORE_FILENAME = "MEMORY.md";
const TOPICS_PREFIX = "topics/";
const JOURNAL_PREFIX = "journal/";
const MD_EXT = ".md";
const JOURNAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KIND_FILE_SECTION = "file-section";
const KIND_JOURNAL = "journal";

const STATUS_SUPERSEDED = "superseded";
/** Reason recorded when a section's content changed (new id) so the prior id's
 *  entry must be status-flipped out of `active` — otherwise repeated edits
 *  accumulate duplicate active entries per sourceRef and pollute spark. */
const REASON_FILE_EDITED = "file-edited";

/** Provenance stamped on entries this module projects from file content
 *  (spec §3.1: model-written file sections are `assistant`-authored). Callers
 *  that know better — the dreamer distilling tainted sessions — supply their
 *  own provenance via `enqueueEntries`. Re-feeding journals through
 *  `enqueueFile` in a rebuild cannot recover per-section taint; that fidelity
 *  belongs to the dreamer's own feed, not the disposable rebuild path. */
const DEFAULT_FILE_PROVENANCE = "assistant";

/** Markdown ATX heading — captures the heading text (sans `#`). */
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

/** Audience line-suffix tag (spec §9, shared scope). A projected file-section
 *  whose text carries this suffix on ANY line is stamped `audience: "adults"`,
 *  which a child-principal session filters at search time (memory-retriever) —
 *  the coarse, section-level counterpart to memory-prompt's per-line render
 *  filter. Deliberately dumb: a trailing suffix match, no structured parse. */
const ADULTS_TAG = "@adults";
const AUDIENCE_ADULTS: EntryAudience = "adults";

/** `"adults"` when any line of a section is `@adults`-tagged, else undefined
 *  (an untagged section carries no audience field — `all` is the absence
 *  default). Over-filters rather than under-filters: one tagged line marks the
 *  whole section adults-only for a child's SEARCH, which is fail-safe. */
function sectionAudience(text: string): EntryAudience | undefined {
  const tagged = text.split("\n").some((line) => line.trim().endsWith(ADULTS_TAG));
  return tagged ? AUDIENCE_ADULTS : undefined;
}

// --- Public contract ---------------------------------------------------------

/**
 * The input shape callers hand to the outbox. Flush fills the derived fields:
 * `id` (deterministic), `createdAt`/`statusChangedAt` (from the injected
 * clock), and `status` (default `active`). Everything else — provenance,
 * `sessionRef`, `audience`, `authorUserId` — is caller-supplied (T19/T22/T24).
 */
export type EnqueueEntry = Omit<IndexEntry, "id" | "createdAt" | "statusChangedAt" | "status"> & {
  status?: IndexEntry["status"];
};

/**
 * Reserved read-only session handle. Raw-chunk projection arrives via
 * `replayRawChunks` today (this module deliberately cannot read the session
 * store), so the handle is carried for call-site parity but never dereferenced.
 */
export type SessionStoreRead = unknown;

/** One scope's wiring: its id, its file store, and its deep-memory dir (where
 *  the cursor lives). `replayRawChunks` is the ONLY way raw chunks re-enter on
 *  rebuild — this module has no session-store reader of its own. */
export type ScopeHandle = {
  scopeId: string;
  store: MemoryStore;
  indexDir: string;
  sessionStore?: SessionStoreRead;
  replayRawChunks?: () => EnqueueEntry[];
};

/** Per-file enqueue options. `authorUserId` attributes a SHARED-scope write to
 *  the member who made it (spec §9): the family `withIndexSync` wrapper passes
 *  the session principal's id; private-scope enqueues (single owner) and
 *  out-of-band reingest (no known author) pass nothing. */
export interface EnqueueFileOptions {
  authorUserId?: string;
}

export interface IndexSync {
  /** Project file-section (or journal) entries from the store's CURRENT
   *  content and queue them. One entry per markdown heading. `@adults`-tagged
   *  sections carry `audience: "adults"`; `opts.authorUserId` (when supplied)
   *  attributes each projected entry (shared-scope writes, spec §9). */
  enqueueFile(file: string, opts?: EnqueueFileOptions): void;
  /** Queue caller-authored entries verbatim (provenance/refs already set). */
  enqueueEntries(entries: EnqueueEntry[]): void;
  /** Retire the index entry a dreamer fact line produced (the reconciler's
   *  SUPERSEDE/FLAG_STALE seam). Recomputes the entry's deterministic id from
   *  `(scope, file-section, file, lineText)` — the exact keying episode-writer's
   *  fact entries use — and stages a `setStatus(superseded, reason)` in
   *  `pendingStatus`, drained on the next `flush()`. Idempotent (a repeat is a
   *  no-op); durable (persisted, so a crash mid-flush replays it). */
  retireEntry(target: string, lineText: string, reason: string): void;
  /** Queue raw transcript chunks — a no-op unless `cfg.spark.raw_chunks`. */
  enqueueSessionChunks(sessionId: string, entries: EnqueueEntry[]): void;
  /** Upsert every queued row through the client; on success mark them done, on
   *  failure leave them queued for the next flush. Never throws. */
  flush(): Promise<void>;
  /** Health recovered — drain whatever the outage left behind. */
  onHealthRecovered(): void;
  /** Drop the index, then replay every source through the idempotent path. */
  rebuildScope(): Promise<Result<void>>;
}

export interface IndexSyncDeps {
  /** ISO-8601 clock, injected for testability. */
  now?: () => string;
}

// --- Cursor (on-disk outbox) -------------------------------------------------

/**
 * The persisted queue. `pending` rows are keyed by their deterministic id, so
 * re-enqueuing unchanged content dedups for free. `pendingStatus` holds
 * supersession ops (priorId → reason) awaiting a `setStatus` call — durable so
 * a crash mid-flush replays them. `lastIdBySource` records the last SUCCESSFULLY
 * upserted id per source key, which is how an edited section's old (now
 * duplicate-active) entry is detected and superseded.
 */
interface SyncCursor {
  version: number;
  pending: Record<string, EnqueueEntry>;
  pendingStatus: Record<string, string>;
  lastIdBySource: Record<string, string>;
}

function emptyCursor(): SyncCursor {
  return { version: CURSOR_VERSION, pending: {}, pendingStatus: {}, lastIdBySource: {} };
}

// --- Deterministic id (spec §5.4) --------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The `sourceRef` component of the id. File-backed entries (sections, journals)
 * key on `{file}#{heading}` exactly as the spec formula reads. Entries with no
 * file source (raw chunks) fall back to their session identity, so identical
 * text in two sessions stays distinct while the same chunk re-feeds converge.
 */
function sourceComponent(entry: EnqueueEntry): string {
  const file = entry.sourceRef?.file ?? "";
  const heading = entry.sourceRef?.heading ?? "";
  if (file !== "" || heading !== "") {
    return `${file}#${heading}`;
  }
  const session = entry.sessionRef;
  const span = session?.entrySpan ? `${session.entrySpan[0]}-${session.entrySpan[1]}` : "";
  return `session:${session?.sessionId ?? ""}:${span}`;
}

/** `hash(scope:kind:sourceRef:contentHash)` — deterministic, so upserts are
 *  idempotent and re-feeds converge. */
function computeId(entry: EnqueueEntry): string {
  return sha256(`${entry.scope}:${entry.kind}:${sourceComponent(entry)}:${sha256(entry.text)}`);
}

// --- Section splitting -------------------------------------------------------

interface Section {
  heading: string | undefined;
  text: string;
}

/**
 * Splits markdown into heading-delimited sections. The preamble before the
 * first heading (if any non-blank text) becomes a headless section; each
 * heading opens a section that runs to the next heading. Blank sections drop.
 */
function splitIntoSections(content: string): Section[] {
  const sections: Section[] = [];
  let heading: string | undefined;
  let lines: string[] = [];

  const flush = (): void => {
    const text = lines.join("\n").trim();
    if (text.length > 0) {
      sections.push({ heading, text });
    }
    lines = [];
  };

  for (const line of content.split("\n")) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flush();
      heading = match[1];
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

// --- File-target routing -----------------------------------------------------

type FileTarget = { kind: "core" } | { kind: "topic"; slug: string } | { kind: "journal"; date: string };

/** Parses a relPath (`MEMORY.md`, `topics/<slug>.md`, `journal/<date>.md`) into
 *  a typed target, rejecting a traversal-shaped slug/date by construction. */
function parseFileTarget(file: string): FileTarget | null {
  if (file === CORE_FILENAME) return { kind: "core" };
  if (file.startsWith(TOPICS_PREFIX)) {
    const slug = basename(file.slice(TOPICS_PREFIX.length), MD_EXT);
    return MEMORY_SLUG_RE.test(slug) ? { kind: "topic", slug } : null;
  }
  if (file.startsWith(JOURNAL_PREFIX)) {
    const date = basename(file.slice(JOURNAL_PREFIX.length), MD_EXT);
    return JOURNAL_DATE_RE.test(date) ? { kind: "journal", date } : null;
  }
  return null;
}

// --- Factory -----------------------------------------------------------------

/**
 * Builds the outbox for one scope. The cursor is loaded once at construction
 * (a fresh instance over the same `indexDir` inherits any queue an outage left
 * behind) and mirrored in memory; this instance is the single writer of the
 * cursor file (one per scope, the composition precedent), so the mirror cannot
 * drift from disk.
 */
export function createIndexSync(
  scope: ScopeHandle,
  client: DeepMemoryClient,
  cfg: MemoryConfig,
  deps: IndexSyncDeps = {},
): IndexSync {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const cursorPath = join(scope.indexDir, CURSOR_FILENAME);
  const cursor = loadCursor(cursorPath);

  function materialize(entry: EnqueueEntry): IndexEntry {
    const createdAt = now();
    return {
      ...entry,
      id: computeId(entry),
      status: entry.status ?? "active",
      createdAt,
      statusChangedAt: createdAt,
    };
  }

  function addToPending(entries: EnqueueEntry[]): number {
    let added = 0;
    for (const entry of entries) {
      cursor.pending[computeId(entry)] = entry;
      added += 1;
    }
    if (added > 0) {
      persistCursor(cursorPath, cursor);
    }
    return added;
  }

  function enqueueFile(file: string, opts: EnqueueFileOptions = {}): void {
    const target = parseFileTarget(file);
    if (target === null) {
      log.warn("index-sync.enqueue-file.unrecognized", { reason: "not a memory relPath" });
      return;
    }
    const content = readTarget(scope.store, target);
    if (content === null) {
      log.debug("index-sync.enqueue-file.absent", { file });
      return;
    }
    const kind = target.kind === "journal" ? KIND_JOURNAL : KIND_FILE_SECTION;
    const entries: EnqueueEntry[] = splitIntoSections(content).map((section) => {
      // `exactOptionalPropertyTypes` forbids an explicit `heading: undefined`.
      const sourceRef: SourceRef = section.heading === undefined ? { file } : { file, heading: section.heading };
      const audience = sectionAudience(section.text);
      return {
        kind,
        text: section.text,
        timestamp: now(),
        scope: scope.scopeId,
        sourceRef,
        provenance: DEFAULT_FILE_PROVENANCE,
        // Both are absent-by-default under `exactOptionalPropertyTypes`, so
        // spread conditionally rather than assigning `undefined`.
        ...(audience !== undefined ? { audience } : {}),
        ...(opts.authorUserId !== undefined ? { authorUserId: opts.authorUserId } : {}),
      };
    });
    addToPending(entries);
    log.info("index-sync.enqueue-file", { file, kind, sections: entries.length, pending: pendingCount(cursor) });
  }

  function enqueueEntries(entries: EnqueueEntry[]): void {
    addToPending(entries);
    log.info("index-sync.enqueue-entries", { count: entries.length, pending: pendingCount(cursor) });
  }

  function retireEntry(target: string, lineText: string, reason: string): void {
    // The id episode-writer stamped on this line's fact entry: a headless
    // file-section keyed on the target file + the line text (computeId +
    // sourceComponent below resolve to `hash(scope:file-section:<file>#:hash(line))`).
    const id = computeId({
      kind: KIND_FILE_SECTION,
      text: lineText,
      timestamp: now(),
      scope: scope.scopeId,
      sourceRef: { file: target },
      provenance: DEFAULT_FILE_PROVENANCE,
    });
    if (cursor.pendingStatus[id] !== undefined) {
      log.debug("index-sync.retire.duplicate", { target, reason });
      return;
    }
    cursor.pendingStatus[id] = reason;
    persistCursor(cursorPath, cursor);
    log.info("index-sync.retire.enqueued", { target, reason, pendingStatus: pendingStatusCount(cursor) });
  }

  function enqueueSessionChunks(sessionId: string, entries: EnqueueEntry[]): void {
    if (!cfg.spark.raw_chunks) {
      log.debug("index-sync.raw-chunks.disabled", { sessionId, count: entries.length });
      return;
    }
    // Force the session identity onto every chunk so its deterministic id is
    // session-scoped (identical utterances across sessions stay distinct).
    const stamped: EnqueueEntry[] = entries.map((entry) => ({
      ...entry,
      sessionRef: { ...(entry.sessionRef ?? { sessionId }), sessionId },
    }));
    addToPending(stamped);
    log.info("index-sync.enqueue-chunks", { sessionId, count: stamped.length, pending: pendingCount(cursor) });
  }

  /** Records a supersession (prior id → reason) for every pending entry whose
   *  source's last-flushed id differs from its new id — an edited section.
   *  Durable: persisted so a crash before the `setStatus` lands replays it. */
  function detectSupersessions(): void {
    let changed = false;
    for (const entry of Object.values(cursor.pending)) {
      const key = sourceComponent(entry);
      const prior = cursor.lastIdBySource[key];
      if (prior && prior !== computeId(entry) && cursor.pendingStatus[prior] === undefined) {
        cursor.pendingStatus[prior] = REASON_FILE_EDITED;
        changed = true;
      }
    }
    if (changed) persistCursor(cursorPath, cursor);
  }

  /** Drains `pendingStatus` via `setStatus` (grouped by reason). A failed group
   *  stays queued like any pending row; a successful one clears. */
  async function applyPendingStatuses(): Promise<void> {
    const byReason = new Map<string, string[]>();
    for (const [id, reason] of Object.entries(cursor.pendingStatus)) {
      const group = byReason.get(reason) ?? [];
      group.push(id);
      byReason.set(reason, group);
    }
    let changed = false;
    for (const [reason, ids] of byReason) {
      const result = await client.setStatus(scope.scopeId, ids, STATUS_SUPERSEDED, reason);
      if (!result.ok) {
        log.warn("index-sync.supersede.deferred", { queued: ids.length, reason, errorKind: result.error.kind });
        continue; // keep queued — retry on the next flush
      }
      for (const id of ids) delete cursor.pendingStatus[id];
      changed = true;
      log.info("index-sync.supersede.ok", { superseded: ids.length, reason });
    }
    if (changed) persistCursor(cursorPath, cursor);
  }

  async function flush(): Promise<void> {
    detectSupersessions();
    const ids = Object.keys(cursor.pending);
    if (ids.length === 0 && pendingStatusCount(cursor) === 0) {
      log.debug("index-sync.flush.noop", {});
      return;
    }

    // Supersede the edited-out entries first, then upsert the new content.
    await applyPendingStatuses();

    if (ids.length === 0) {
      return;
    }
    const entries: IndexEntry[] = [];
    for (const id of ids) {
      const queued = cursor.pending[id];
      if (queued) entries.push(materialize(queued));
    }
    const result = await client.upsert(scope.scopeId, entries);
    if (!result.ok) {
      log.warn("index-sync.flush.deferred", { queued: ids.length, errorKind: result.error.kind });
      return; // leave queued — retry on the next flush / health recovery
    }
    // Mark done: drop only the ids we flushed (keeping any enqueued mid-await)
    // and advance each source's high-water id so the next edit can supersede it.
    for (const entry of entries) {
      cursor.lastIdBySource[sourceComponent(entry)] = entry.id;
      delete cursor.pending[entry.id];
    }
    persistCursor(cursorPath, cursor);
    log.info("index-sync.flush.ok", { upserted: entries.length, remaining: pendingCount(cursor) });
  }

  function onHealthRecovered(): void {
    log.info("index-sync.health-recovered", { queued: pendingCount(cursor) });
    void flush();
  }

  async function rebuildScope(): Promise<Result<void>> {
    const dropped = await client.rebuild(scope.scopeId);
    if (!dropped.ok) {
      log.warn("index-sync.rebuild.refused", { errorKind: dropped.error.kind });
      return { ok: false, error: mapError(dropped.error) };
    }
    // Rebuild is a pure current-state snapshot: discard any queued rows (which
    // may reference now-overwritten content) and the supersession bookkeeping
    // (the index was just dropped — nothing to supersede) before re-feeding.
    cursor.pending = {};
    cursor.pendingStatus = {};
    cursor.lastIdBySource = {};
    persistCursor(cursorPath, cursor);

    enqueueFile(CORE_FILENAME);
    for (const topic of scope.store.listTopics()) {
      enqueueFile(`${TOPICS_PREFIX}${topic.name}${MD_EXT}`);
    }
    for (const date of scope.store.listJournal()) {
      enqueueFile(`${JOURNAL_PREFIX}${date}${MD_EXT}`);
    }
    if (cfg.spark.raw_chunks && scope.replayRawChunks) {
      enqueueEntries(scope.replayRawChunks());
    }
    await flush();
    log.info("index-sync.rebuild.ok", { queued: pendingCount(cursor) });
    return { ok: true, value: undefined };
  }

  return { enqueueFile, enqueueEntries, retireEntry, enqueueSessionChunks, flush, onHealthRecovered, rebuildScope };
}

// --- Helpers -----------------------------------------------------------------

function readTarget(store: MemoryStore, target: FileTarget): string | null {
  switch (target.kind) {
    case "core":
      return store.readCore();
    case "topic":
      return store.readTopic(target.slug);
    case "journal":
      return store.readJournal(target.date);
  }
}

function pendingCount(cursor: SyncCursor): number {
  return Object.keys(cursor.pending).length;
}

function pendingStatusCount(cursor: SyncCursor): number {
  return Object.keys(cursor.pendingStatus).length;
}

function mapError(error: ClientError): string {
  return error.kind;
}

function loadCursor(cursorPath: string): SyncCursor {
  let raw: string;
  try {
    raw = readFileSync(cursorPath, "utf8");
  } catch {
    return emptyCursor(); // no cursor yet — nothing queued
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.pending && typeof parsed.pending === "object") {
      return {
        version: CURSOR_VERSION,
        pending: parsed.pending as Record<string, EnqueueEntry>,
        // Tolerate an older cursor file that predates these fields.
        pendingStatus: asRecord(parsed.pendingStatus),
        lastIdBySource: asRecord(parsed.lastIdBySource),
      };
    }
  } catch {
    log.warn("index-sync.cursor.corrupt", { reason: "unparseable — starting empty" });
  }
  return emptyCursor();
}

function asRecord(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

function persistCursor(cursorPath: string, cursor: SyncCursor): void {
  mkdirSync(dirname(cursorPath), { recursive: true });
  const tmpPath = join(dirname(cursorPath), `.${basename(cursorPath)}.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(cursor, null, 2), "utf8");
  renameSync(tmpPath, cursorPath);
}
