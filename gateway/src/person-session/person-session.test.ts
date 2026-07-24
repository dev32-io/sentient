import { describe, expect, it } from "vitest";
import { PersonSession, type PersonSessionAttachment } from "./person-session.js";

function makeSession(): PersonSession {
  return new PersonSession({
    profile: "alice",
    hermesUrl: "http://hermes-alice:8643",
    hermesApiKey: "test-key",
    userId: null,
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

  it("hasLiveResources reflects attachment presence", () => {
    const s = makeSession();
    expect(s.hasLiveResources()).toBe(false);
    const a = makeAttachment("a");
    s.attach(a);
    expect(s.hasLiveResources()).toBe(true);
    s.detach(a);
    expect(s.hasLiveResources()).toBe(false);
  });

  it("dispose is safe to call and does not throw", () => {
    const s = makeSession();
    expect(() => s.dispose()).not.toThrow();
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
