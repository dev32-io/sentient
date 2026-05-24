import { describe, expect, it } from "vitest";
import { SESSION_DEFAULTS, createSessionPersistence } from "./session-persistence.ts";
import type { SessionState } from "./session-persistence.ts";

const BASE_TIME = 1_000_000;

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: "sess-1",
    userId: "user-1",
    role: "user",
    createdAt: BASE_TIME,
    lastActiveAt: BASE_TIME,
    status: "active",
    ...overrides,
  };
}

function makeClock(initial: number): { now: () => number; advance: (ms: number) => void } {
  let time = initial;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("SESSION_DEFAULTS", () => {
  it("suspendWindowMs is 120_000", () => {
    expect(SESSION_DEFAULTS.suspendWindowMs).toBe(120_000);
  });

  it("replayBufferCapacity is 100", () => {
    expect(SESSION_DEFAULTS.replayBufferCapacity).toBe(100);
  });
});

describe("SessionPersistence — core lifecycle", () => {
  it("save then get retrieves session", () => {
    const store = createSessionPersistence({ now: () => BASE_TIME });
    const session = makeSession();
    store.save(session);
    expect(store.get("sess-1")).toEqual(session);
  });

  it("get unknown sessionId returns null", () => {
    const store = createSessionPersistence();
    expect(store.get("unknown")).toBeNull();
  });

  it("get returns a copy not the original reference", () => {
    const store = createSessionPersistence();
    store.save(makeSession());
    const copy = store.get("sess-1");
    if (!copy) throw new Error("Expected session");
    copy.lastActiveAt = 9_999_999;
    expect(store.get("sess-1")?.lastActiveAt).toBe(BASE_TIME);
  });

  it("touch updates lastActiveAt to current time", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession());
    clock.advance(5_000);
    store.touch("sess-1");
    expect(store.get("sess-1")?.lastActiveAt).toBe(BASE_TIME + 5_000);
  });

  it("suspend marks session status as suspended", () => {
    const store = createSessionPersistence();
    store.save(makeSession());
    store.suspend("sess-1");
    expect(store.get("sess-1")?.status).toBe("suspended");
  });

  it("canResume returns true within suspend window", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession());
    store.suspend("sess-1");
    clock.advance(SESSION_DEFAULTS.suspendWindowMs - 1);
    expect(store.canResume("sess-1")).toBe(true);
  });

  it("canResume returns false after suspend window expires", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession());
    store.suspend("sess-1");
    clock.advance(SESSION_DEFAULTS.suspendWindowMs + 1);
    expect(store.canResume("sess-1")).toBe(false);
  });

  it("canResume returns false for unknown session", () => {
    const store = createSessionPersistence();
    expect(store.canResume("unknown")).toBe(false);
  });

  it("canResume returns false for active session", () => {
    const store = createSessionPersistence();
    store.save(makeSession());
    expect(store.canResume("sess-1")).toBe(false);
  });

  it("resume within window transitions status to active and returns true", () => {
    const store = createSessionPersistence({ now: () => BASE_TIME });
    store.save(makeSession());
    store.suspend("sess-1");
    expect(store.resume("sess-1")).toBe(true);
    expect(store.get("sess-1")?.status).toBe("active");
  });

  it("resume rejects already-active session and returns false", () => {
    const store = createSessionPersistence();
    store.save(makeSession());
    expect(store.resume("sess-1")).toBe(false);
  });

  it("resume after window expires returns false and preserves suspended status", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession());
    store.suspend("sess-1");
    clock.advance(SESSION_DEFAULTS.suspendWindowMs + 1);
    expect(store.resume("sess-1")).toBe(false);
    expect(store.get("sess-1")?.status).toBe("suspended");
  });

  it("destroy removes session from store", () => {
    const store = createSessionPersistence();
    store.save(makeSession());
    store.destroy("sess-1");
    expect(store.get("sess-1")).toBeNull();
  });

  it("cleanup removes expired suspended sessions", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession({ sessionId: "sess-1" }));
    store.save(makeSession({ sessionId: "sess-2" }));
    store.suspend("sess-1");
    clock.advance(SESSION_DEFAULTS.suspendWindowMs + 1);
    store.suspend("sess-2");
    store.cleanup();
    expect(store.get("sess-1")).toBeNull();
    expect(store.get("sess-2")).not.toBeNull();
  });

  it("cleanup preserves non-expired suspended sessions", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession());
    store.suspend("sess-1");
    clock.advance(10_000);
    store.cleanup();
    expect(store.get("sess-1")).not.toBeNull();
  });

  it("cleanup does not throw when no sessions exist", () => {
    const store = createSessionPersistence();
    expect(() => store.cleanup()).not.toThrow();
  });

  it("activeSessions returns only sessions with status active", () => {
    const store = createSessionPersistence();
    store.save(makeSession({ sessionId: "sess-1" }));
    store.save(makeSession({ sessionId: "sess-2" }));
    store.suspend("sess-2");
    const active = store.activeSessions();
    expect(active).toHaveLength(1);
    expect(active[0]?.sessionId).toBe("sess-1");
  });

  it("totalCount includes both active and suspended sessions", () => {
    const store = createSessionPersistence();
    store.save(makeSession({ sessionId: "sess-1" }));
    store.save(makeSession({ sessionId: "sess-2" }));
    store.suspend("sess-2");
    expect(store.totalCount()).toBe(2);
  });
});
