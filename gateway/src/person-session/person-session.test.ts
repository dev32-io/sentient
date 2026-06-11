import { describe, expect, it } from "vitest";
import { PersonSession, type PersonSessionAttachment } from "./person-session.js";

const REPLAY_BUFFER_MAX_BYTES = 1024 * 64; // 64 KB — small for tests

function makeSession(): PersonSession {
  return new PersonSession({
    profile: "alice",
    hermesUrl: "http://hermes-alice:8643",
    hermesApiKey: "test-key",
    userId: null,
    replayBufferMaxBytes: REPLAY_BUFFER_MAX_BYTES,
  });
}

function makeAttachment(id: string): PersonSessionAttachment {
  return { attachmentId: id };
}

describe("PersonSession", () => {
  it("exposes identity fields from init", () => {
    const s = makeSession();
    expect(s.profile).toBe("alice");
    expect(s.hermesUrl).toBe("http://hermes-alice:8643");
    expect(s.hermesApiKey).toBe("test-key");
  });

  it("exposes userId from init", () => {
    const ps = new PersonSession({
      profile: "kevin",
      hermesUrl: "http://h:1",
      hermesApiKey: "k",
      userId: "kevin",
      replayBufferMaxBytes: REPLAY_BUFFER_MAX_BYTES,
    });
    expect(ps.userId).toBe("kevin");
  });

  it("starts with no attachments and is idle", () => {
    const s = makeSession();
    expect(s.attachmentCount).toBe(0);
    expect(s.isIdle).toBe(true);
  });

  it("attaches and tracks count", () => {
    const s = makeSession();
    s.attach(makeAttachment("a"));
    s.attach(makeAttachment("b"));
    expect(s.attachmentCount).toBe(2);
    expect(s.isIdle).toBe(false);
  });

  it("ignores duplicate attach of the same token", () => {
    const s = makeSession();
    const a = makeAttachment("a");
    s.attach(a);
    s.attach(a);
    expect(s.attachmentCount).toBe(1);
  });

  it("detaches and becomes idle when last attachment leaves", () => {
    const s = makeSession();
    const a = makeAttachment("a");
    s.attach(a);
    s.detach(a);
    expect(s.attachmentCount).toBe(0);
    expect(s.isIdle).toBe(true);
  });

  it("detach is idempotent — unknown token is a no-op", () => {
    const s = makeSession();
    s.detach(makeAttachment("ghost"));
    expect(s.attachmentCount).toBe(0);
  });

  it("lastResponseId is null on construct, mutates via setter", () => {
    const s = makeSession();
    expect(s.lastResponseId).toBeNull();
    s.setLastResponseId("resp_xyz");
    expect(s.lastResponseId).toBe("resp_xyz");
    s.setLastResponseId(null);
    expect(s.lastResponseId).toBeNull();
  });

  it("ageMs grows monotonically", async () => {
    const s = makeSession();
    const a1 = s.ageMs;
    await new Promise((r) => setTimeout(r, 5));
    const a2 = s.ageMs;
    expect(a2).toBeGreaterThanOrEqual(a1);
  });

  it("attachments() returns a snapshot that does not mutate the internal set", () => {
    const s = makeSession();
    const a = makeAttachment("a");
    s.attach(a);
    const snap = s.attachments();
    expect(snap).toHaveLength(1);
    // mutating the snapshot must not affect the session
    (snap as PersonSessionAttachment[]).pop();
    expect(s.attachmentCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Per-device replay buffer
  // -------------------------------------------------------------------------

  it("acquireDeviceBuffer returns resumed:false and epoch 1 on first call", () => {
    const s = makeSession();
    const result = s.acquireDeviceBuffer("dev-A");
    expect(result.resumed).toBe(false);
    expect(result.epoch).toBe(1);
    expect(result.buffer).toBeDefined();
  });

  it("acquireDeviceBuffer resumes the same buffer when resumeEpoch matches", () => {
    const s = makeSession();
    const first = s.acquireDeviceBuffer("dev-A");
    s.releaseDeviceBuffer("dev-A");
    const second = s.acquireDeviceBuffer("dev-A", { resumeEpoch: first.epoch });
    expect(second.resumed).toBe(true);
    expect(second.epoch).toBe(first.epoch);
    expect(second.buffer).toBe(first.buffer);
  });

  it("acquireDeviceBuffer creates a fresh buffer when resumeEpoch does not match", () => {
    const s = makeSession();
    const first = s.acquireDeviceBuffer("dev-A");
    s.releaseDeviceBuffer("dev-A");
    const second = s.acquireDeviceBuffer("dev-A", { resumeEpoch: 999 });
    expect(second.resumed).toBe(false);
    expect(second.epoch).toBe(2);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("acquireDeviceBuffer creates independent buffers per deviceId", () => {
    const s = makeSession();
    const a = s.acquireDeviceBuffer("dev-A");
    const b = s.acquireDeviceBuffer("dev-B");
    expect(a.buffer).not.toBe(b.buffer);
    expect(a.epoch).toBe(1);
    expect(b.epoch).toBe(2);
  });

  it("bufferFor and epochFor return the active entry values", () => {
    const s = makeSession();
    const { buffer, epoch } = s.acquireDeviceBuffer("dev-A");
    expect(s.bufferFor("dev-A")).toBe(buffer);
    expect(s.epochFor("dev-A")).toBe(epoch);
  });

  it("bufferFor and epochFor return undefined for unknown deviceId", () => {
    const s = makeSession();
    expect(s.bufferFor("unknown")).toBeUndefined();
    expect(s.epochFor("unknown")).toBeUndefined();
  });

  it("hasRetainedBuffers is false before any acquire, true after", () => {
    const s = makeSession();
    expect(s.hasRetainedBuffers()).toBe(false);
    s.acquireDeviceBuffer("dev-A");
    expect(s.hasRetainedBuffers()).toBe(true);
  });

  it("sweepExpired evicts detached entries past TTL", () => {
    const s = makeSession();
    const TTL = 30_000;

    s.acquireDeviceBuffer("dev-A");
    s.releaseDeviceBuffer("dev-A");
    s.acquireDeviceBuffer("dev-B");
    s.releaseDeviceBuffer("dev-B");

    // Sweep far in the future — both entries are past the TTL.
    const FAR_FUTURE = Date.now() + TTL + 1000;
    const evicted = s.sweepExpired(FAR_FUTURE, TTL);
    expect(evicted).toBe(2);
    expect(s.hasRetainedBuffers()).toBe(false);
  });

  it("sweepExpired does not evict a still-attached entry (detachedAtMs is null)", () => {
    const s = makeSession();
    s.acquireDeviceBuffer("dev-A");
    // Never released — detachedAtMs remains null.
    const evicted = s.sweepExpired(Number.MAX_SAFE_INTEGER, 0);
    expect(evicted).toBe(0);
    expect(s.hasRetainedBuffers()).toBe(true);
  });
});

describe("PersonSession.admitPendingId", () => {
  it("admits a new pendingId once, rejects the duplicate", () => {
    const s = makeSession();
    expect(s.admitPendingId("p1")).toBe(true);
    expect(s.admitPendingId("p1")).toBe(false);
  });
  it("admits distinct ids", () => {
    const s = makeSession();
    expect(s.admitPendingId("p1")).toBe(true);
    expect(s.admitPendingId("p2")).toBe(true);
  });
  it("evicts oldest beyond the cap so the set is bounded", () => {
    const s = makeSession();
    for (let i = 0; i < 300; i++) expect(s.admitPendingId(`p${i}`)).toBe(true);
    // p0 was evicted (cap 256) -> re-admitting it succeeds (treated as new)
    expect(s.admitPendingId("p0")).toBe(true);
    // a recent one is still remembered
    expect(s.admitPendingId("p299")).toBe(false);
  });
});
