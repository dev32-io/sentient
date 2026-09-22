import { describe, expect, it } from "bun:test";
import { createReplayRegistry } from "./replay-registry.js";

describe("ReplayRegistry — deletion invalidation", () => {
  it("invalidates an attached journal immediately and ignores its stale lease", () => {
    const registry = createReplayRegistry({ maxBytesPerSession: 1024, retentionMs: 60_000 });
    const before = registry.acquire("s_deleted");
    before.journal.allocateText("turn.text.delta", () => "old");

    registry.invalidate("s_deleted");
    expect(registry.size).toBe(0);

    const after = registry.acquire("s_deleted");
    expect(after.reused).toBe(false);
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.journal.newestSeq).toBe(0);

    registry.release(before.lease);
    expect(registry.size).toBe(1);
    expect(registry.acquire("s_deleted").epoch).toBe(after.epoch);
  });
});
