// S3a dream transaction — the checkpoint ORDER and its four outcomes (spec §8).
// These pin the security-relevant invariants: the mark advances LAST and ONLY on
// a clean journal write, so a crash before it redoes the same window (idempotent
// by construction); a scan-refused journal and a template-load throw both
// abandon the night WITHOUT advancing; a toggled-off user advances the mark
// without running (no unbounded backlog).

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig } from "@sentient/config";
import { orchestratorConfigSchema } from "@sentient/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "../../access/capability.js";
import { scanContent } from "../../security/injection-scanner.js";
import type { SessionEntry } from "../../store/entry-types.js";
import type { UserId } from "../../user-auth/user-id.js";
import type { EnqueueEntry, IndexSync } from "../index-sync.js";
import { type MemoryStore, openMemoryStore } from "../memory-store.js";
import { buildDeepDreamWindow, createDreamTransaction } from "./dream-transaction.js";
import type { DreamScopeHandle } from "./dream-transaction.js";
import type { DreamResult } from "./dreamer-runner.js";
import { type WriteDreamOutputsResult, writeDreamOutputs } from "./episode-writer.js";
import type { ApplyResult, ReduceOp } from "./reconciler.js";

const memoryCfg: OrchestratorConfig["memory"] = orchestratorConfigSchema.shape.memory.parse({});

const USER = "u_alice" as unknown as UserId;

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

function memoryDir(): string {
  const d = mkdtempSync(join(tmpdir(), "dream-tx-"));
  tempDirs.push(d);
  return d;
}

function entry(seq: number, sessionId: string): SessionEntry {
  return {
    seq,
    sessionId,
    turnId: `t-${seq}`,
    replyId: null,
    kind: "user",
    createdAt: seq * 1000,
    text: `msg ${seq}`,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  };
}

const ONE_SESSION_RESULT: DreamResult = {
  sessions: [{ sessionId: "s1", episode: "the user said hi", facts: [], containsToolDerived: false }],
};

const WRITE_OK: WriteDreamOutputsResult = { ok: true, episodeEntries: 1, journalEntries: 1, factEntries: 0 };

interface HandleOverrides {
  lastSeq?: number;
  maxSeq?: number;
  runMapStage?: DreamScopeHandle["runner"]["runMapStage"];
  runReduceStage?: DreamScopeHandle["runner"]["runReduceStage"];
  advanceMark?: () => void;
  retireEntry?: (target: string, lineText: string, reason: string) => void;
  order?: string[];
  listJournal?: () => string[];
  readJournal?: (date: string) => string | null;
}

function makeHandle(
  dir: string,
  o: HandleOverrides = {},
): DreamScopeHandle & {
  advanceMark: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  const order = o.order ?? [];
  const advanceMark = vi.fn(
    o.advanceMark ??
      (() => {
        order.push("advance");
      }),
  );
  const flush = vi.fn(async () => {
    order.push("flush");
  });
  const runner = {
    readMark: vi.fn(() => ({ lastSeq: o.lastSeq ?? 0, lastRunAt: null })),
    advanceMark,
    runMapStage: o.runMapStage ?? vi.fn(async () => ONE_SESSION_RESULT),
    // Default: a quiet night (no ops) — the semantic half is a clean `ok` no-op.
    runReduceStage: o.runReduceStage ?? vi.fn(async () => []),
  };
  // Minimal store: the reduce stage reads current memory off it (all absent);
  // listJournal/readJournal back `triggerDeepDream`'s window build (empty by
  // default — a deep-dream test overrides them with seeded journal days).
  const store = {
    readCore: () => null,
    listTopics: () => [],
    readTopic: () => null,
    listJournal: o.listJournal ?? (() => []),
    readJournal: o.readJournal ?? (() => null),
  } as unknown as MemoryStore;
  const sync = { flush, retireEntry: o.retireEntry ?? vi.fn(() => {}) } as unknown as IndexSync;
  return {
    userId: USER,
    scopeId: "user:u_alice",
    memoryDir: dir,
    store,
    sync,
    runner: runner as unknown as DreamScopeHandle["runner"],
    readWindow: () => ({ entries: [entry(1, "s1"), entry(2, "s1")], maxSeq: o.maxSeq ?? 12 }),
    advanceMark,
    flush,
  };
}

function readStatus(dir: string): { result: string; sessions: number; ops: number; reason?: string } {
  return JSON.parse(readFileSync(join(dir, ".dream-status.json"), "utf8"));
}

describe("createDreamTransaction.runDreamFor", () => {
  it("advances the mark LAST, after the journal write and index flush", async () => {
    const dir = memoryDir();
    const order: string[] = [];
    const handle = makeHandle(dir, { order });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => {
      order.push("write");
      return WRITE_OK;
    });
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
    });

    const outcome = await tx.runDreamFor("u_alice");

    expect(outcome.result).toBe("ok");
    expect(order).toEqual(["write", "flush", "advance"]);
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 12, expect.any(String));
    expect(readStatus(dir)).toMatchObject({ result: "ok", sessions: 1, ops: 0 });
  });

  it("redoes the SAME window when the mark was never advanced (crash between write and mark)", async () => {
    const dir = memoryDir();
    // Mark stuck at lastSeq=5 across both runs — a mark that never persisted.
    const dates: unknown[] = [];
    const results: unknown[] = [];
    const advancedTo: unknown[] = [];
    const writeOutputs = vi.fn((...args: unknown[]): WriteDreamOutputsResult => {
      dates.push(args[3]);
      results.push(args[4]);
      return WRITE_OK;
    });
    const openDreamScope = (): DreamScopeHandle => {
      const h = makeHandle(dir, { lastSeq: 5, maxSeq: 20 });
      const inner = h.runner.advanceMark;
      h.runner.advanceMark = ((...a: unknown[]) => {
        advancedTo.push(a[1]);
        return (inner as (...x: unknown[]) => void)(...a);
      }) as typeof h.runner.advanceMark;
      return h;
    };
    const tx = createDreamTransaction({
      openDreamScope,
      readDreamMark: () => ({ lastSeq: 5, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
    });

    await tx.runDreamFor("u_alice");
    await tx.runDreamFor("u_alice");

    // Journal written both times, same date + same result — last-wins by date
    // heading; both runs target the same immutable window head (maxSeq = 20).
    expect(writeOutputs).toHaveBeenCalledTimes(2);
    expect(dates[0]).toBe(dates[1]);
    expect(results[0]).toBe(ONE_SESSION_RESULT);
    expect(results[1]).toBe(ONE_SESSION_RESULT);
    expect(advancedTo).toEqual([20, 20]);
  });

  it("does NOT advance the mark when the journal write is scan-refused", async () => {
    const dir = memoryDir();
    const handle = makeHandle(dir);
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => ({ ok: false, error: "scan_rejected" }));
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
    });

    const outcome = await tx.runDreamFor("u_alice");

    expect(outcome.result).toBe("failed");
    expect(outcome.reason).toBe("journal-refused");
    expect(handle.advanceMark).not.toHaveBeenCalled();
    expect(handle.flush).not.toHaveBeenCalled();
    expect(readStatus(dir)).toMatchObject({ result: "failed", reason: "journal-refused" });
  });

  it("does NOT advance the mark when the map stage throws (template-load failure)", async () => {
    const dir = memoryDir();
    const handle = makeHandle(dir, {
      runMapStage: vi.fn(async () => {
        throw new Error("dreamer map template missing");
      }),
    });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => WRITE_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
    });

    const outcome = await tx.runDreamFor("u_alice");

    expect(outcome.result).toBe("failed");
    expect(outcome.reason).toBe("map-stage");
    expect(writeOutputs).not.toHaveBeenCalled();
    expect(handle.advanceMark).not.toHaveBeenCalled();
    expect(readStatus(dir)).toMatchObject({ result: "failed", reason: "map-stage" });
  });

  it("returns failed without touching the mark when the scope cannot be opened", async () => {
    const tx = createDreamTransaction({
      openDreamScope: () => null,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
    });
    const outcome = await tx.runDreamFor("u_alice");
    expect(outcome.result).toBe("failed");
    expect(outcome.reason).toBe("scope-unavailable");
  });
});

describe("createDreamTransaction.skipAndAdvance", () => {
  it("advances the mark to maxSeq WITHOUT running the map stage (toggle off, no backlog)", async () => {
    const dir = memoryDir();
    const runMapStage = vi.fn(async () => ONE_SESSION_RESULT);
    const handle = makeHandle(dir, { runMapStage, maxSeq: 42 });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => WRITE_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
    });

    const outcome = await tx.skipAndAdvance("u_alice");

    expect(outcome.result).toBe("skipped");
    expect(runMapStage).not.toHaveBeenCalled();
    expect(writeOutputs).not.toHaveBeenCalled();
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 42, expect.any(String));
    expect(readStatus(dir)).toMatchObject({ result: "skipped", reason: "dreaming-off" });
  });
});

describe("createDreamTransaction.initialize", () => {
  it("seeds the mark to head WITHOUT any provider call (first-run, no backlog dreaming)", async () => {
    const dir = memoryDir();
    const runMapStage = vi.fn(async () => ONE_SESSION_RESULT); // the ONLY provider path
    const handle = makeHandle(dir, { runMapStage, maxSeq: 999 });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => WRITE_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
    });

    const outcome = await tx.initialize("u_alice");

    expect(outcome.result).toBe("initialized");
    // ZERO provider invocations — the whole point of the fix.
    expect(runMapStage).not.toHaveBeenCalled();
    expect(writeOutputs).not.toHaveBeenCalled();
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 999, expect.any(String));
    expect(readStatus(dir)).toMatchObject({ result: "initialized", reason: "first-run" });
  });
});

describe("createDreamTransaction.bootDecisionFor", () => {
  const NOW = 1_700_000_000_000; // a realistic epoch-ms "now"
  const HOUR = 60 * 60 * 1000;
  const base = createDreamTransaction({
    openDreamScope: () => null,
    readDreamMark: (userId) => {
      if (userId === "missing") return { lastSeq: 0, lastRunAt: null };
      if (userId === "recent") return { lastSeq: 0, lastRunAt: new Date(NOW - HOUR).toISOString() };
      return { lastSeq: 0, lastRunAt: new Date(NOW - 100 * HOUR).toISOString() }; // stale (> 24h)
    },
    cfg: memoryCfg,
    now: () => NOW,
  });

  it("initializes when the mark is missing / never run (no back-history dream)", async () => {
    await expect(base.bootDecisionFor("missing")).resolves.toBe("initialize");
  });

  it("skips when an existing mark ran within the threshold", async () => {
    await expect(base.bootDecisionFor("recent")).resolves.toBe("skip");
  });

  it("dreams when an existing mark is older than the threshold (a missed night)", async () => {
    await expect(base.bootDecisionFor("stale")).resolves.toBe("dream");
  });
});

// ---------------------------------------------------------------------------
// Full transaction — the SEMANTIC half (reduce → reconcile → applied op log).
// ---------------------------------------------------------------------------

const ONE_OP: ReduceOp = { op: "ADD", target: "MEMORY.md", line: "a new fact", sources: [{ fromSeq: 1, toSeq: 2 }] };
const APPLY_OK: ApplyResult = {
  ok: true,
  applied: [
    { op: "ADD", target: "MEMORY.md", line: "a new fact", sources: [{ fromSeq: 1, toSeq: 2 }], sessionIds: [] },
  ],
};

describe("createDreamTransaction.runDreamFor — full transaction (reduce + reconcile)", () => {
  it("applies reduce ops and passes the APPLIED op log into the journal write", async () => {
    const dir = memoryDir();
    const handle = makeHandle(dir, { runReduceStage: vi.fn(async () => [ONE_OP]) });
    let writtenOps: unknown;
    const writeOutputs = vi.fn((...args: unknown[]): WriteDreamOutputsResult => {
      writtenOps = args[5];
      return WRITE_OK;
    });
    const applyOps = vi.fn(async (): Promise<ApplyResult> => APPLY_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      applyOps,
    });

    const outcome = await tx.runDreamFor("u_alice");

    expect(outcome.result).toBe("ok");
    expect(outcome.ops).toBe(1);
    expect(applyOps).toHaveBeenCalledTimes(1);
    expect(writtenOps).toEqual(APPLY_OK.ok ? APPLY_OK.applied : []);
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 12, expect.any(String));
    expect(readStatus(dir)).toMatchObject({ result: "ok", ops: 1 });
  });

  it("completes ok-episodic-only (mark ADVANCES, no ops) when the reduce call double-fails", async () => {
    const dir = memoryDir();
    const handle = makeHandle(dir, { runReduceStage: vi.fn(async () => null) });
    let writtenOps: unknown;
    const writeOutputs = vi.fn((...args: unknown[]): WriteDreamOutputsResult => {
      writtenOps = args[5];
      return WRITE_OK;
    });
    const applyOps = vi.fn(async (): Promise<ApplyResult> => APPLY_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      applyOps,
    });

    const outcome = await tx.runDreamFor("u_alice");

    expect(outcome.result).toBe("ok-episodic-only");
    expect(outcome.reason).toBe("reduce-unavailable");
    expect(applyOps).not.toHaveBeenCalled(); // no ops to apply
    expect(writtenOps).toEqual([]); // journal written WITH NO OPS — episodes not lost
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 12, expect.any(String)); // mark STILL advances
    expect(readStatus(dir)).toMatchObject({ result: "ok-episodic-only", reason: "reduce-unavailable" });
  });

  it("completes ok-episodic-only when the reconciler REFUSES the batch (rail), mark still advances", async () => {
    const dir = memoryDir();
    const handle = makeHandle(dir, { runReduceStage: vi.fn(async () => [ONE_OP]) });
    let writtenOps: unknown;
    const writeOutputs = vi.fn((...args: unknown[]): WriteDreamOutputsResult => {
      writtenOps = args[5];
      return WRITE_OK;
    });
    const applyOps = vi.fn(
      async (): Promise<ApplyResult> => ({ ok: false, refused: "rail", detail: "prior=4 next=1" }),
    );
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      applyOps,
    });

    const outcome = await tx.runDreamFor("u_alice");

    expect(outcome.result).toBe("ok-episodic-only");
    expect(outcome.reason).toBe("reduce-refused:rail");
    expect(writtenOps).toEqual([]); // NO ops in the journal on a refusal
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 12, expect.any(String));
    expect(readStatus(dir)).toMatchObject({ result: "ok-episodic-only", reason: "reduce-refused:rail" });
  });
});

// ---------------------------------------------------------------------------
// Crash tests at EVERY boundary — a crash NEVER advances the mark (unless it
// is the mark write itself that crashed, after the journal committed); the
// rerun redoes the SAME immutable window and converges.
// ---------------------------------------------------------------------------

describe("createDreamTransaction.runDreamFor — crash at every boundary redoes the window", () => {
  it("crash AFTER MAP (reduce throws): failed, no journal, no mark; rerun converges", async () => {
    const dir = memoryDir();
    let reduceCalls = 0;
    const runReduceStage = vi.fn(async () => {
      reduceCalls += 1;
      if (reduceCalls === 1) throw new Error("provider socket died mid-reduce");
      return [] as ReduceOp[];
    });
    const handle = makeHandle(dir, { runReduceStage, maxSeq: 20 });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => WRITE_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
    });

    const first = await tx.runDreamFor("u_alice");
    expect(first.result).toBe("failed");
    expect(first.reason).toBe("crash");
    expect(writeOutputs).not.toHaveBeenCalled(); // never reached the journal
    expect(handle.advanceMark).not.toHaveBeenCalled(); // mark intact → window redone

    const second = await tx.runDreamFor("u_alice");
    expect(second.result).toBe("ok");
    expect(writeOutputs).toHaveBeenCalledTimes(1);
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 20, expect.any(String)); // SAME window head
  });

  it("crash AFTER REDUCE, before apply (applyOps throws): failed, no journal, no mark; rerun converges", async () => {
    const dir = memoryDir();
    const handle = makeHandle(dir, { runReduceStage: vi.fn(async () => [ONE_OP]), maxSeq: 20 });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => WRITE_OK);
    let applyCalls = 0;
    const applyOps = vi.fn(async (): Promise<ApplyResult> => {
      applyCalls += 1;
      if (applyCalls === 1) throw new Error("store handle vanished mid-apply");
      return APPLY_OK;
    });
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      applyOps,
    });

    const first = await tx.runDreamFor("u_alice");
    expect(first.result).toBe("failed");
    expect(writeOutputs).not.toHaveBeenCalled();
    expect(handle.advanceMark).not.toHaveBeenCalled();

    const second = await tx.runDreamFor("u_alice");
    expect(second.result).toBe("ok");
    expect(applyOps).toHaveBeenCalledTimes(2); // ops RE-DERIVED and re-applied
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 20, expect.any(String));
  });

  it("crash AFTER APPLY, before journal (writeOutputs throws): failed, no mark; rerun converges", async () => {
    const dir = memoryDir();
    const handle = makeHandle(dir, { runReduceStage: vi.fn(async () => [ONE_OP]), maxSeq: 20 });
    let writeCalls = 0;
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => {
      writeCalls += 1;
      if (writeCalls === 1) throw new Error("disk full writing journal");
      return WRITE_OK;
    });
    const applyOps = vi.fn(async (): Promise<ApplyResult> => APPLY_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      applyOps,
    });

    const first = await tx.runDreamFor("u_alice");
    expect(first.result).toBe("failed");
    expect(handle.advanceMark).not.toHaveBeenCalled();

    const second = await tx.runDreamFor("u_alice");
    expect(second.result).toBe("ok");
    expect(handle.advanceMark).toHaveBeenCalledWith(dir, 20, expect.any(String));
  });

  it("crash AFTER JOURNAL, before mark (advanceMark throws): journal committed, mark stale; rerun converges with no duplicate index entries", async () => {
    // The ONE convergence test wired to a REAL store + REAL writeDreamOutputs +
    // a capturing sync, so the journal-last-wins + deterministic-id idempotence
    // is verified against the real writer, not a stub.
    const dir = memoryDir();
    const storeRoot = mkdtempSync(join(tmpdir(), "dream-conv-"));
    tempDirs.push(storeRoot);
    const cap = {
      ownerUserId: "u_alice",
      resource: "memory-private",
      rootPath: storeRoot,
      role: "adult",
    } as unknown as Capability;
    const store = openMemoryStore(cap, memoryCfg, { scan: scanContent });
    store.writeCore("The household uses a voice assistant."); // prior content to archive

    const enqueued: EnqueueEntry[][] = [];
    const sync = {
      enqueueFile: () => {},
      enqueueEntries: (entries: EnqueueEntry[]) => enqueued.push(entries),
      retireEntry: () => {},
      enqueueSessionChunks: () => {},
      flush: async () => {},
      onHealthRecovered: () => {},
      rebuildScope: async () => ({ ok: true, value: undefined }),
    } as unknown as IndexSync;

    let advanceCalls = 0;
    const advanceMark = (): void => {
      advanceCalls += 1;
      if (advanceCalls === 1) throw new Error("rename EIO advancing mark");
    };
    // A scan-CLEAN episode: the real writeDreamOutputs scans the journal
    // fail-closed, so the map result must not contain injection-flagged text.
    const cleanResult: DreamResult = {
      sessions: [
        {
          sessionId: "s1",
          episode: "The family talked about weekend plans over dinner.",
          facts: [],
          containsToolDerived: false,
        },
      ],
    };
    const handle = makeHandle(dir, { advanceMark, maxSeq: 20, runMapStage: vi.fn(async () => cleanResult) });
    // Swap the real store + capturing sync into the handle.
    const liveHandle: DreamScopeHandle = { ...handle, store, sync };

    const tx = createDreamTransaction({
      openDreamScope: () => liveHandle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs: writeDreamOutputs, // REAL writer
    });

    const first = await tx.runDreamFor("u_alice");
    expect(first.result).toBe("failed"); // advanceMark threw AFTER the journal wrote
    const journalDir = join(storeRoot, "memory", "journal");
    expect(existsSync(journalDir)).toBe(true);
    const journalFiles = readdirSync(journalDir);
    expect(journalFiles).toHaveLength(1); // journal committed despite the crash
    const journalAfterFirst = readFileSync(join(journalDir, journalFiles[0] as string), "utf8");

    const second = await tx.runDreamFor("u_alice");
    expect(second.result).toBe("ok"); // this time the mark advances

    // Journal LAST-WINS by date: still exactly one file, byte-identical.
    expect(readdirSync(journalDir)).toEqual(journalFiles);
    expect(readFileSync(join(journalDir, journalFiles[0] as string), "utf8")).toBe(journalAfterFirst);

    // Index entries CONVERGE: both runs enqueued the same (kind, text, sourceRef)
    // set — deterministic ids mean a real outbox upserts in place, no duplicates.
    expect(enqueued).toHaveLength(2);
    const key = (batch: EnqueueEntry[]): string =>
      JSON.stringify(batch.map((e) => [e.kind, e.text, e.sourceRef]).sort());
    expect(key(enqueued[0] as EnqueueEntry[])).toBe(key(enqueued[1] as EnqueueEntry[]));
  });
});

// ---------------------------------------------------------------------------
// Deep dreaming (spec §8 "later slice"): on-demand consolidation over journals,
// not raw session-store entries. Pinned invariants: correct journal/episode
// window selection; the nightly checkpoint mark is NEVER advanced; no writes
// land outside the private scope the handle was opened on.
// ---------------------------------------------------------------------------

/** A journal file byte-for-byte compatible with `parseJournalEpisodes` (the
 *  real `## session <id>[ [tool-derived]]` heading contract). */
function journalFixture(sessionId: string, tainted: boolean, episode: string): string {
  return [
    "# heading",
    "narrative",
    `## session ${sessionId}${tainted ? " [tool-derived]" : ""}`,
    "",
    episode,
    "## memory updates",
    "",
    "No memory updates this night.",
  ].join("\n\n");
}

function readDeepDreamStatus(dir: string): { result: string; sessions: number; ops: number; reason?: string } {
  return JSON.parse(readFileSync(join(dir, ".deep-dream-status.json"), "utf8"));
}

describe("buildDeepDreamWindow", () => {
  const NOW = Date.parse("2026-08-09T12:00:00Z");

  it("selects only journal days within [today - windowDays, today], one pseudo-session per day", () => {
    const files = new Map<string, string>([
      ["2026-08-01", journalFixture("s-old", false, "too old to matter")],
      ["2026-08-05", journalFixture("s1", false, "in range, clean")],
      ["2026-08-07", journalFixture("s2", true, "in range, tainted")],
      ["2026-08-09", journalFixture("s3", false, "today")],
    ]);
    const store = { listJournal: () => [...files.keys()].sort(), readJournal: (d: string) => files.get(d) ?? null };

    const window = buildDeepDreamWindow(store, 3, NOW); // cutoff = 2026-08-06

    expect(window.sessions.map((s) => s.sessionId)).toEqual(["journal-2026-08-07", "journal-2026-08-09"]);
    expect(window.sessions[0]?.containsToolDerived).toBe(true); // taint recovered via parseJournalEpisodes
    expect(window.sessions[1]?.containsToolDerived).toBe(false);
  });

  it("skips a day whose journal cannot be read (missing/quarantined) rather than fabricating one", () => {
    const store = { listJournal: () => ["2026-08-08", "2026-08-09"], readJournal: () => null };
    expect(buildDeepDreamWindow(store, 7, NOW).sessions).toEqual([]);
  });

  it("includes today's own journal day when in range", () => {
    const store = {
      listJournal: () => ["2026-08-09"],
      readJournal: () => journalFixture("s-today", false, "today's episode"),
    };
    expect(buildDeepDreamWindow(store, 1, NOW).sessions).toHaveLength(1);
  });
});

describe("createDreamTransaction.triggerDeepDream", () => {
  const NOW = Date.parse("2026-08-09T12:00:00Z");
  const DEEP_DREAM_RESULT: DreamResult = {
    sessions: [
      { sessionId: "journal-2026-08-07", episode: "consolidated week", facts: [], containsToolDerived: false },
    ],
  };

  function seededHandle(dir: string, o: HandleOverrides = {}): ReturnType<typeof makeHandle> {
    return makeHandle(dir, {
      listJournal: () => ["2026-08-07"],
      readJournal: () => journalFixture("s1", false, "the week's episode"),
      runMapStage: vi.fn(async () => DEEP_DREAM_RESULT),
      ...o,
    });
  }

  it("consolidates journal days into a journal entry dated TODAY with a 'deep dream over N days' narrative", async () => {
    const dir = memoryDir();
    const handle = seededHandle(dir);
    let capturedArgs: unknown[] = [];
    const writeOutputs = vi.fn((...args: unknown[]): WriteDreamOutputsResult => {
      capturedArgs = args;
      return WRITE_OK;
    });
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      now: () => NOW,
    });

    const outcome = await tx.triggerDeepDream("u_alice", 7);

    expect(outcome.result).toBe("ok");
    expect(writeOutputs).toHaveBeenCalledTimes(1);
    expect(capturedArgs[2]).toBe(handle.scopeId); // date, and narrative override
    expect(capturedArgs[3]).toBe("2026-08-09"); // dated TODAY, not the window's last day
    expect(capturedArgs[4]).toBe(DEEP_DREAM_RESULT);
    expect(capturedArgs[6]).toBe("Deep dream over 7 days.");
    expect(readDeepDreamStatus(dir)).toMatchObject({ result: "ok" });
  });

  it("selects the map-stage window from journals, not the session-store readWindow", async () => {
    const dir = memoryDir();
    let windowSeen: unknown;
    const handle = seededHandle(dir, {
      runMapStage: vi.fn(async (_user, window) => {
        windowSeen = window;
        return DEEP_DREAM_RESULT;
      }),
    });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => WRITE_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      now: () => NOW,
    });

    await tx.triggerDeepDream("u_alice", 7);

    // The seeded journal day (2026-08-07), NOT the readWindow's raw session "s1".
    expect(windowSeen).toEqual({
      sessions: [{ sessionId: "journal-2026-08-07", text: expect.any(String), containsToolDerived: false }],
    });
  });

  it("NEVER advances the nightly checkpoint mark — deep dreaming re-reads already-dreamed journals", async () => {
    const dir = memoryDir();
    const handle = seededHandle(dir, { runReduceStage: vi.fn(async () => [ONE_OP]) });
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => WRITE_OK);
    const applyOps = vi.fn(async (): Promise<ApplyResult> => APPLY_OK);
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      applyOps,
      now: () => NOW,
    });

    const outcome = await tx.triggerDeepDream("u_alice", 30);

    expect(outcome.result).toBe("ok");
    expect(outcome.ops).toBe(1); // ops WERE applied
    expect(handle.advanceMark).not.toHaveBeenCalled(); // yet the mark never moved
  });

  it("writes only to the handle's own (private) scope — never a different scopeId", async () => {
    const dir = memoryDir();
    const handle = seededHandle(dir);
    const seenScopeIds = new Set<string>();
    const writeOutputs = vi.fn((...args: unknown[]): WriteDreamOutputsResult => {
      seenScopeIds.add(args[2] as string);
      return WRITE_OK;
    });
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      now: () => NOW,
    });

    await tx.triggerDeepDream("u_alice", 7);

    expect([...seenScopeIds]).toEqual([handle.scopeId]);
    expect(handle.scopeId.startsWith("family")).toBe(false); // never the shared scope
  });

  it("does NOT advance the mark on a journal-refused (scan-rejected) write", async () => {
    const dir = memoryDir();
    const handle = seededHandle(dir);
    const writeOutputs = vi.fn((): WriteDreamOutputsResult => ({ ok: false, error: "scan_rejected" }));
    const tx = createDreamTransaction({
      openDreamScope: () => handle,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      writeOutputs,
      now: () => NOW,
    });

    const outcome = await tx.triggerDeepDream("u_alice", 7);

    expect(outcome.result).toBe("failed");
    expect(outcome.reason).toBe("journal-refused");
    expect(handle.advanceMark).not.toHaveBeenCalled();
    expect(readDeepDreamStatus(dir)).toMatchObject({ result: "failed", reason: "journal-refused" });
  });

  it("returns failed without touching the mark when the scope cannot be opened", async () => {
    const tx = createDreamTransaction({
      openDreamScope: () => null,
      readDreamMark: () => ({ lastSeq: 0, lastRunAt: null }),
      cfg: memoryCfg,
      now: () => NOW,
    });

    const outcome = await tx.triggerDeepDream("u_alice", 7);

    expect(outcome.result).toBe("failed");
    expect(outcome.reason).toBe("scope-unavailable");
  });
});
