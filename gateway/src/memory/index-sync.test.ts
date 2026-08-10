import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import { scanContent } from "../security/injection-scanner.js";
import type { ClientError, DeepMemoryClient, HealthInfo, IndexEntry } from "./deep-memory-client.js";
import type { EnqueueEntry, ScopeHandle } from "./index-sync.js";
import { createIndexSync } from "./index-sync.js";
import { type MemoryConfig, type MemoryStore, openMemoryStore } from "./memory-store.js";

// A fixed clock — createdAt/timestamp become assertable and never wall-clock.
const FIXED_NOW = "2026-08-09T00:00:00.000Z";
const now = (): string => FIXED_NOW;

/** Guarded index access — `noUncheckedIndexedAccess` widens `arr[i]` to
 *  `T | undefined`; this narrows and fails loudly on an out-of-range read. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`index ${index} out of range`);
  return value;
}

const SCOPE_ID = "user:u1:private";

function memCfg(rawChunks: boolean): MemoryConfig {
  return {
    core_max_lines: 300,
    core_max_chars: 12000,
    topic_max_lines: 2000,
    topic_max_chars: 80000,
    spark: { raw_chunks: rawChunks },
  } as unknown as MemoryConfig;
}

function makeCap(root: string): Capability {
  return { ownerUserId: "u1", resource: "memory-private", rootPath: root, role: "adult" } as unknown as Capability;
}

const HEALTH: HealthInfo = { status: "ok", version: "1", embeddingModel: "m", indexSchemaVersion: 1 };

interface SetStatusCall {
  scopeId: string;
  ids: string[];
  status: string;
  reason: string;
}

interface FakeClient {
  client: DeepMemoryClient;
  upserts: { scopeId: string; entries: IndexEntry[] }[];
  setStatuses: SetStatusCall[];
  rebuilds: string[];
  setFail(kind: ClientError["kind"] | null): void;
}

function makeFakeClient(): FakeClient {
  let failKind: ClientError["kind"] | null = null;
  const upserts: { scopeId: string; entries: IndexEntry[] }[] = [];
  const setStatuses: SetStatusCall[] = [];
  const rebuilds: string[] = [];
  const ok = { ok: true as const, value: undefined };
  const err = (): { ok: false; error: ClientError } => ({ ok: false, error: { kind: failKind ?? "unavailable" } });
  const client: DeepMemoryClient = {
    registerScope: async () => ok,
    upsert: async (scopeId, entries) => {
      if (failKind) return err();
      upserts.push({ scopeId, entries });
      return ok;
    },
    search: async () => ({ ok: true, value: [] }),
    setStatus: async (scopeId, ids, status, reason) => {
      if (failKind) return err();
      setStatuses.push({ scopeId, ids, status, reason });
      return ok;
    },
    purge: async () => ok,
    rebuild: async (scopeId) => {
      if (failKind) return err();
      rebuilds.push(scopeId);
      return ok;
    },
    health: async () => ({ ok: true, value: HEALTH }),
  };
  const setFail = (kind: ClientError["kind"] | null): void => {
    failKind = kind;
  };
  return { client, upserts, setStatuses, rebuilds, setFail };
}

let root: string;
let indexDir: string;
let store: MemoryStore;

function makeScope(extra: Partial<ScopeHandle> = {}): ScopeHandle {
  return { scopeId: SCOPE_ID, store, indexDir, ...extra };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "index-sync-test-"));
  indexDir = join(root, "deep-memory");
  store = openMemoryStore(makeCap(root), memCfg(false), { scan: scanContent });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("enqueueFile — file-section projection", () => {
  it("projects one entry per markdown heading and upserts on flush", async () => {
    store.writeCore("## Alpha\nfirst fact\n## Beta\nsecond fact");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    sync.enqueueFile("MEMORY.md");
    await sync.flush();

    expect(fake.upserts.length).toBe(1);
    const entries = at(fake.upserts, 0).entries;
    expect(entries.length).toBe(2);
    const headings = entries.map((e) => e.sourceRef.heading).sort();
    expect(headings).toEqual(["Alpha", "Beta"]);
    for (const e of entries) {
      expect(e.kind).toBe("file-section");
      expect(e.scope).toBe(SCOPE_ID);
      expect(e.sourceRef.file).toBe("MEMORY.md");
      expect(e.status).toBe("active");
      expect(e.createdAt).toBe(FIXED_NOW);
      expect(e.statusChangedAt).toBe(FIXED_NOW);
      expect(typeof e.id).toBe("string");
      expect(e.id.length).toBeGreaterThan(0);
    }
  });

  it("no-ops when the target file does not exist", async () => {
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    expect(fake.upserts.length).toBe(0);
  });
});

describe("outbox durability", () => {
  it("keeps rows queued when the service is unavailable, retrying on health recovery", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    fake.setFail("unavailable");
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    expect(fake.upserts.length).toBe(0); // outage — nothing landed

    fake.setFail(null);
    sync.onHealthRecovered();
    // onHealthRecovered fires flush asynchronously; await a tick.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.upserts.length).toBe(1);
    expect(at(fake.upserts, 0).entries.length).toBe(1);
  });

  it("persists the queue across a fresh IndexSync over the same indexDir", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fakeA = makeFakeClient();
    fakeA.setFail("unavailable");
    const syncA = createIndexSync(makeScope(), fakeA.client, memCfg(false), { now });
    syncA.enqueueFile("MEMORY.md");
    await syncA.flush(); // fails — row stays queued and on disk
    expect(existsSync(join(indexDir, ".sync-cursor.json"))).toBe(true);

    // Brand-new instance, healthy client, same cursor dir.
    const fakeB = makeFakeClient();
    const syncB = createIndexSync(makeScope(), fakeB.client, memCfg(false), { now });
    await syncB.flush();
    expect(fakeB.upserts.length).toBe(1);
    expect(at(fakeB.upserts, 0).entries.length).toBe(1);
  });

  it("clears the queue after a successful flush", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    await sync.flush(); // nothing left to send
    expect(fake.upserts.length).toBe(1);
  });
});

describe("deterministic ids — idempotent re-flush", () => {
  it("produces identical ids when the same content is re-enqueued and re-flushed", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    sync.enqueueFile("MEMORY.md");
    await sync.flush();

    expect(fake.upserts.length).toBe(2);
    const idsFirst = at(fake.upserts, 0).entries.map((e) => e.id);
    const idsSecond = at(fake.upserts, 1).entries.map((e) => e.id);
    expect(idsSecond).toEqual(idsFirst);
  });

  it("changes the id when the section content changes", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    const idBefore = at(at(fake.upserts, 0).entries, 0).id;

    store.writeCore("## Alpha\nchanged fact");
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    const idAfter = at(at(fake.upserts, 1).entries, 0).id;
    expect(idAfter).not.toBe(idBefore);
  });
});

describe("supersede-on-edit — no duplicate active entries per source", () => {
  it("supersedes the prior id and upserts exactly one new entry when a section is edited", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    const priorId = at(at(fake.upserts, 0).entries, 0).id;

    store.writeCore("## Alpha\nedited fact");
    sync.enqueueFile("MEMORY.md");
    await sync.flush();

    // Exactly one setStatus, flipping the prior id to superseded.
    expect(fake.setStatuses.length).toBe(1);
    expect(at(fake.setStatuses, 0).ids).toEqual([priorId]);
    expect(at(fake.setStatuses, 0).status).toBe("superseded");
    expect(at(fake.setStatuses, 0).reason).toBe("file-edited");

    // Exactly one new entry upserted on the edit flush, with a new id.
    expect(at(fake.upserts, 1).entries.length).toBe(1);
    expect(at(at(fake.upserts, 1).entries, 0).id).not.toBe(priorId);
  });

  it("does not supersede when the same content is re-flushed", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    expect(fake.setStatuses.length).toBe(0);
  });

  it("keeps the supersession queued when setStatus fails, retrying on the next flush", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    sync.enqueueFile("MEMORY.md");
    await sync.flush();

    fake.setFail("unavailable");
    store.writeCore("## Alpha\nedited fact");
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    expect(fake.setStatuses.length).toBe(0); // outage — supersession deferred

    fake.setFail(null);
    await sync.flush();
    expect(fake.setStatuses.length).toBe(1);
  });
});

describe("rebuildScope — drop and re-feed all sources", () => {
  it("rebuilds then re-feeds core, topics, and journals through the idempotent path", async () => {
    store.writeCore("## Core\ncore fact");
    store.writeTopic("trips", { name: "trips", description: "where we went" }, "## Tahoe\nskiing");
    store.writeJournal("2026-08-09", "## session s1\nwe talked about skiing");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    const res = await sync.rebuildScope();
    expect(res.ok).toBe(true);
    expect(fake.rebuilds).toEqual([SCOPE_ID]);
    expect(fake.upserts.length).toBe(1);

    const entries = at(fake.upserts, 0).entries;
    const files = entries.map((e) => e.sourceRef.file).sort();
    expect(files).toContain("MEMORY.md");
    expect(files).toContain("topics/trips.md");
    expect(files).toContain("journal/2026-08-09.md");
    const journalEntry = entries.find((e) => e.sourceRef.file === "journal/2026-08-09.md");
    expect(journalEntry?.kind).toBe("journal");
  });

  it("discards stale pending rows and feeds only current state", async () => {
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    // A stale row queued (never flushed) referencing content that no longer exists.
    sync.enqueueEntries([
      {
        kind: "file-section",
        text: "deleted topic content",
        timestamp: FIXED_NOW,
        scope: SCOPE_ID,
        sourceRef: { file: "topics/gone.md", heading: "Old" },
        provenance: "assistant",
      },
    ]);

    store.writeCore("## Fresh\ncurrent fact");
    const res = await sync.rebuildScope();
    expect(res.ok).toBe(true);

    const files = at(fake.upserts, 0).entries.map((e) => e.sourceRef.file);
    expect(files).toEqual(["MEMORY.md"]); // stale topics/gone.md row is gone
  });

  it("surfaces the client error and does not re-feed when rebuild is refused", async () => {
    store.writeCore("## Core\ncore fact");
    const fake = makeFakeClient();
    fake.setFail("rebuild_required");
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    const res = await sync.rebuildScope();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("rebuild_required");
    expect(fake.upserts.length).toBe(0);
  });
});

describe("raw chunks — gated by cfg.spark.raw_chunks", () => {
  const rawEntry = (text: string, sessionId: string): EnqueueEntry => ({
    kind: "raw-chunk",
    text,
    timestamp: FIXED_NOW,
    scope: SCOPE_ID,
    sourceRef: {},
    sessionRef: { sessionId },
    provenance: "user-speech",
  });

  it("no-ops when raw_chunks is disabled (default)", async () => {
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    sync.enqueueSessionChunks("s1", [rawEntry("hello there", "s1")]);
    await sync.flush();
    expect(fake.upserts.length).toBe(0);
  });

  it("projects deterministic chunk ids when raw_chunks is enabled", async () => {
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(true), { now });

    sync.enqueueSessionChunks("s1", [rawEntry("hello there", "s1")]);
    await sync.flush();
    sync.enqueueSessionChunks("s1", [rawEntry("hello there", "s1")]);
    await sync.flush();

    expect(fake.upserts.length).toBe(2);
    expect(at(at(fake.upserts, 0).entries, 0).kind).toBe("raw-chunk");
    expect(at(at(fake.upserts, 0).entries, 0).sessionRef?.sessionId).toBe("s1");
    expect(at(at(fake.upserts, 1).entries, 0).id).toBe(at(at(fake.upserts, 0).entries, 0).id);
  });

  it("gives distinct ids to identical text from different sessions", async () => {
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(true), { now });
    sync.enqueueSessionChunks("s1", [rawEntry("same words", "s1")]);
    sync.enqueueSessionChunks("s2", [rawEntry("same words", "s2")]);
    await sync.flush();
    const ids = at(fake.upserts, 0).entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("re-feeds raw chunks in rebuildScope only when enabled", async () => {
    store.writeCore("## Core\ncore fact");
    const fake = makeFakeClient();
    const replayRawChunks = (): EnqueueEntry[] => [rawEntry("replayed chunk", "s1")];
    const sync = createIndexSync(makeScope({ replayRawChunks }), fake.client, memCfg(true), { now });

    await sync.rebuildScope();
    const kinds = at(fake.upserts, 0).entries.map((e) => e.kind);
    expect(kinds).toContain("raw-chunk");
  });
});

describe("enqueueFile — @adults audience + authorUserId (T24, spec §9)", () => {
  it("stamps audience:adults on an @adults-tagged section and none on an untagged one", async () => {
    store.writeCore("## Safe\ndinner is at 6\n## Secret\nthe safe code is 1234 @adults");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    sync.enqueueFile("MEMORY.md");
    await sync.flush();

    const entries = at(fake.upserts, 0).entries;
    const byHeading = new Map(entries.map((e) => [e.sourceRef.heading, e]));
    expect(byHeading.get("Secret")?.audience).toBe("adults");
    // An untagged section carries NO audience field — `all` is the absence default.
    expect(byHeading.get("Safe")?.audience).toBeUndefined();
  });

  it("stamps authorUserId on every projected section when supplied, none otherwise", async () => {
    store.writeCore("## Alpha\nfact one\n## Beta\nfact two");
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });

    sync.enqueueFile("MEMORY.md", { authorUserId: "u_alice" });
    await sync.flush();
    for (const e of at(fake.upserts, 0).entries) expect(e.authorUserId).toBe("u_alice");

    // Distinct content (author is NOT part of the deterministic id, so the same
    // text would dedup) enqueued with no author stamps nothing.
    store.writeCore("## Gamma\nprivate fact");
    sync.enqueueFile("MEMORY.md");
    await sync.flush();
    for (const e of at(fake.upserts, 1).entries) expect(e.authorUserId).toBeUndefined();
  });

  it("keeps the entry id independent of authorUserId — attribution is metadata, not identity", async () => {
    store.writeCore("## Alpha\nfact one");
    const authored = makeFakeClient();
    const anon = makeFakeClient();

    const syncA = createIndexSync(makeScope(), authored.client, memCfg(false), { now });
    syncA.enqueueFile("MEMORY.md", { authorUserId: "u_alice" });
    await syncA.flush();

    const syncB = createIndexSync(makeScope(), anon.client, memCfg(false), { now });
    syncB.enqueueFile("MEMORY.md");
    await syncB.flush();

    // Same scope + kind + sourceRef + content ⇒ same deterministic id, whether or
    // not an author was stamped (so re-feeds still converge / dedup).
    expect(at(at(authored.upserts, 0).entries, 0).id).toBe(at(at(anon.upserts, 0).entries, 0).id);
  });
});

describe("enqueueEntries — caller-supplied provenance and refs", () => {
  it("carries audience, authorUserId, sessionRef, and provenance onto the upserted entry", async () => {
    const fake = makeFakeClient();
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    const entry: EnqueueEntry = {
      kind: "episode-summary",
      text: "we decided on the blue kitchen tiles",
      timestamp: FIXED_NOW,
      scope: SCOPE_ID,
      sourceRef: { file: "journal/2026-08-09.md", heading: "session s1" },
      sessionRef: { sessionId: "s1", entrySpan: [4, 9] },
      provenance: "tool-derived",
      audience: "adults",
      authorUserId: "u1",
    };
    sync.enqueueEntries([entry]);
    await sync.flush();

    const got = at(at(fake.upserts, 0).entries, 0);
    expect(got.audience).toBe("adults");
    expect(got.authorUserId).toBe("u1");
    expect(got.provenance).toBe("tool-derived");
    expect(got.sessionRef).toEqual({ sessionId: "s1", entrySpan: [4, 9] });
    expect(got.status).toBe("active");
  });

  it("does not persist a cursor file until something is enqueued", () => {
    const fake = makeFakeClient();
    createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    expect(existsSync(join(indexDir, ".sync-cursor.json"))).toBe(false);
  });

  it("writes cursor JSON that carries the pending rows verbatim", async () => {
    store.writeCore("## Alpha\nfirst fact");
    const fake = makeFakeClient();
    fake.setFail("unavailable");
    const sync = createIndexSync(makeScope(), fake.client, memCfg(false), { now });
    sync.enqueueFile("MEMORY.md");
    await sync.flush();

    const raw = JSON.parse(readFileSync(join(indexDir, ".sync-cursor.json"), "utf8"));
    expect(Object.keys(raw.pending).length).toBe(1);
  });
});
