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
    const result = s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    expect(result.resumed).toBe(false);
    expect(result.epoch).toBe(1);
    expect(result.buffer).toBeDefined();
  });

  it("acquireDeviceBuffer resumes the same buffer when resumeEpoch matches", () => {
    const s = makeSession();
    const first = s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    s.releaseDeviceBuffer("surf-A");
    const second = s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A", resumeEpoch: first.epoch });
    expect(second.resumed).toBe(true);
    expect(second.epoch).toBe(first.epoch);
    expect(second.buffer).toBe(first.buffer);
  });

  it("acquireDeviceBuffer creates a fresh buffer when resumeEpoch does not match", () => {
    const s = makeSession();
    const first = s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    s.releaseDeviceBuffer("surf-A");
    const second = s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A", resumeEpoch: 999 });
    expect(second.resumed).toBe(false);
    expect(second.epoch).toBe(2);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("acquireDeviceBuffer creates independent buffers per surfaceId", () => {
    const s = makeSession();
    const a = s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    const b = s.acquireDeviceBuffer("surf-B", { deviceId: "dev-B" });
    expect(a.buffer).not.toBe(b.buffer);
    expect(a.epoch).toBe(1);
    expect(b.epoch).toBe(2);
  });

  it("bufferFor and epochFor return the active entry values", () => {
    const s = makeSession();
    const { buffer, epoch } = s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    expect(s.bufferFor("surf-A")).toBe(buffer);
    expect(s.epochFor("surf-A")).toBe(epoch);
  });

  it("bufferFor and epochFor return undefined for unknown surfaceId", () => {
    const s = makeSession();
    expect(s.bufferFor("unknown")).toBeUndefined();
    expect(s.epochFor("unknown")).toBeUndefined();
  });

  it("hasRetainedBuffers is false before any acquire, true after", () => {
    const s = makeSession();
    expect(s.hasRetainedBuffers()).toBe(false);
    s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    expect(s.hasRetainedBuffers()).toBe(true);
  });

  it("sweepIdle evicts detached idle entries past the window", () => {
    const s = makeSession();
    const IDLE_TIMEOUT = 30_000;

    s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    s.releaseDeviceBuffer("surf-A");
    s.acquireDeviceBuffer("surf-B", { deviceId: "dev-B" });
    s.releaseDeviceBuffer("surf-B");

    // Sweep far in the future — both entries are past the idle timeout.
    const FAR_FUTURE = Date.now() + IDLE_TIMEOUT + 1000;
    const evicted = s.sweepIdle(FAR_FUTURE, IDLE_TIMEOUT);
    expect(evicted).toBe(2);
    expect(s.hasRetainedBuffers()).toBe(false);
  });

  it("sweepIdle force-closes a still-attached idle entry (does not remove it here)", () => {
    const s = makeSession();
    s.acquireDeviceBuffer("surf-A", { deviceId: "dev-A" });
    // Never released — still attached.
    const evicted = s.sweepIdle(Number.MAX_SAFE_INTEGER, 0);
    expect(evicted).toBe(0);
    expect(s.hasRetainedBuffers()).toBe(true);
  });
});

describe("PersonSession — wires/cycles/anchors composition", () => {
  function makeSession(): PersonSession {
    return new PersonSession({
      profile: "u_00000001",
      hermesUrl: "http://localhost:1/ws",
      hermesApiKey: "k",
      userId: "u_00000001",
      replayBufferMaxBytes: 1024,
    });
  }

  it("owns per-user wire and cycle registries", () => {
    const s = makeSession();
    expect(s.wires.hasLiveWires()).toBe(false);
    expect(s.cycles.hasActiveLease()).toBe(false);
  });

  it("anchors are per-surface read/write/drop", () => {
    const s = makeSession();
    expect(s.conversationIdFor("surf")).toBeNull();
    s.updateConversationId("surf", "conv-1");
    expect(s.conversationIdFor("surf")).toBe("conv-1");
    s.dropAnchor("surf");
    expect(s.conversationIdFor("surf")).toBeNull();
  });

  it("clearAllAnchors drops every anchor", () => {
    const s = makeSession();
    s.updateConversationId("a", "c1");
    s.updateConversationId("b", "c2");
    s.clearAllAnchors();
    expect(s.conversationIdFor("a")).toBeNull();
    expect(s.conversationIdFor("b")).toBeNull();
  });

  it("hasLiveResources is true while a wire is pooled even with no buffers", async () => {
    const s = makeSession();
    expect(s.hasLiveResources()).toBe(false);
    await s.wires.acquire("surf", async () => ({ acpConn: {} as never, dispose: () => {} }));
    expect(s.hasLiveResources()).toBe(true);
    s.wires.release("surf");
    expect(s.hasLiveResources()).toBe(false);
  });

  it("dispose force-disposes wires, aborts cycles, clears anchors", async () => {
    const s = makeSession();
    let disposed = 0;
    await s.wires.acquire("surf", async () => ({
      acpConn: {} as never,
      dispose: () => {
        disposed++;
      },
    }));
    const ctrl = new AbortController();
    s.cycles.acquire("surf", "c1", ctrl);
    s.updateConversationId("surf", "c1");
    s.dispose();
    expect(disposed).toBe(1);
    expect(ctrl.signal.aborted).toBe(true);
    expect(s.conversationIdFor("surf")).toBeNull();
    expect(s.hasLiveResources()).toBe(false);
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
