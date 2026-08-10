// Zero-cost dreamer replay — runs the LIVE-captured reduce output
// (`fixtures/dreamer.fixture.json`, produced by `dreamer.live.test.ts`) back
// through the reconciler `applyOps` against the fixture's pre-state MEMORY.md,
// with NO provider call. This is the free regression net: a rail, scan, or
// source-mapping bug in the reconciler re-fails here immediately, without ever
// spending a token on the paid live smoke.
//
// The fixture is real model output. If a future run recaptures it with different
// ops, this test follows automatically — it asserts the reconciler's INVARIANTS
// (every op applied, MEMORY.md grew, prior lines preserved, rail held), not the
// exact captured lines.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Capability } from "../../access/capability.js";
import { scanContent } from "../../security/injection-scanner.js";
import { type MemoryConfig, type MemoryStore, openMemoryStore } from "../memory-store.js";
import { type ReduceOp, type SessionIndexEntry, applyOps, reduceReplySchema } from "./reconciler.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dreamer.fixture.json");

interface Fixture {
  reduce: { responseText: string };
  preState: { memoryMd: string };
  reduceOps: ReduceOp[];
  sessionsIndex: SessionIndexEntry[];
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

function memCfg(): MemoryConfig {
  return {
    core_max_lines: 300,
    core_max_chars: 12000,
    topic_max_lines: 2000,
    topic_max_chars: 80000,
    spark: { raw_chunks: false },
    dreamer: { preservation_pct: 75 },
  } as unknown as MemoryConfig;
}

const dirs: string[] = [];
function tmpStore(): MemoryStore {
  const root = mkdtempSync(join(tmpdir(), "dreamer-replay-"));
  dirs.push(root);
  const cap = { ownerUserId: "u1", resource: "memory-private", rootPath: root, role: "adult" } as unknown as Capability;
  return openMemoryStore(cap, memCfg(), { scan: scanContent });
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("dreamer replay — captured reduce output through the reconciler (zero-cost)", () => {
  it("re-parses the captured reduce responseText to the same ops the fixture stored", () => {
    const fx = loadFixture();
    const start = fx.reduce.responseText.indexOf("{");
    const end = fx.reduce.responseText.lastIndexOf("}");
    const parsed = reduceReplySchema.safeParse(JSON.parse(fx.reduce.responseText.slice(start, end + 1)));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ops).toEqual(fx.reduceOps);
  });

  it("applies every captured op against the pre-state MEMORY.md, rail + scan holding", async () => {
    const fx = loadFixture();
    expect(fx.reduceOps.length).toBeGreaterThanOrEqual(1);

    const store = tmpStore();
    store.writeCore(fx.preState.memoryMd);
    const priorLines = fx.preState.memoryMd.split("\n").length;

    const out = await applyOps(
      store,
      { retireLine: async () => {}, scan: scanContent },
      "user:u1:private",
      fx.reduceOps,
      fx.sessionsIndex,
      memCfg(),
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Every op is in the applied log with its source-resolved sessions.
    expect(out.applied).toHaveLength(fx.reduceOps.length);

    const coreAfter = store.readCore() ?? "";
    // Preservation rail held: prior lines are all still present (they lead).
    expect(coreAfter.startsWith(fx.preState.memoryMd)).toBe(true);
    // MEMORY.md grew by the ADD lines the reduce produced.
    expect(coreAfter.split("\n").length).toBeGreaterThan(priorLines);
    // Every ADD op's line landed verbatim.
    for (const op of fx.reduceOps) {
      if (op.op === "ADD") expect(coreAfter).toContain(op.line);
    }
  });

  it("still refuses if the captured ops would trip the preservation rail (rail is live in replay)", async () => {
    const fx = loadFixture();
    const store = tmpStore();
    store.writeCore(fx.preState.memoryMd);

    // A pathological batch: flag every prior line stale — must trip the rail
    // (proving the rail is exercised on the real fixture store, not bypassed).
    const staleAll: ReduceOp[] = fx.preState.memoryMd.split("\n").map(
      (line) =>
        ({
          op: "FLAG_STALE",
          target: "MEMORY.md",
          old_line: line,
          reason: "replay-rail-probe",
          sources: [],
        }) as ReduceOp,
    );

    const out = await applyOps(
      store,
      { retireLine: async () => {}, scan: scanContent },
      "user:u1:private",
      staleAll,
      fx.sessionsIndex,
      memCfg(),
    );

    // One prior line → floor min(0.75,0)=0, dropping it → 0 lines, allowed (the
    // one-line escape hatch). Two+ prior lines → dropping ALL trips the rail.
    if (priorLineCount(fx) >= 2) {
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.refused).toBe("rail");
    } else {
      expect(out.ok).toBe(true);
    }
  });
});

function priorLineCount(fx: Fixture): number {
  return fx.preState.memoryMd.split("\n").length;
}
