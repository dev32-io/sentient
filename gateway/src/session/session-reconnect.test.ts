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

describe("SessionPersistence — replay and reconnect", () => {
  it("addReplayMessage does not affect non-suspended sessions", () => {
    const store = createSessionPersistence();
    store.save(makeSession());
    store.addReplayMessage("sess-1", { type: "text", content: "hello" });
    store.addReplayMessage("sess-1", { type: "text", content: "world" });
    expect(store.reconnect("sess-1", 0).success).toBe(false);
  });

  it("reconnect success returns missed messages and resumes session", () => {
    const store = createSessionPersistence({ now: () => BASE_TIME });
    store.save(makeSession());
    store.addReplayMessage("sess-1", { type: "text", content: "msg1" });
    store.addReplayMessage("sess-1", { type: "text", content: "msg2" });
    store.suspend("sess-1");
    const result = store.reconnect("sess-1", 0);
    expect(result.success).toBe(true);
    expect(result.missedMessages).toHaveLength(2);
    expect(store.get("sess-1")?.status).toBe("active");
  });

  it("reconnect updates lastActiveAt on success", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession());
    store.suspend("sess-1");
    clock.advance(30_000);
    store.reconnect("sess-1", 0);
    expect(store.get("sess-1")?.lastActiveAt).toBe(BASE_TIME + 30_000);
  });

  it("reconnect fails for unknown session", () => {
    const store = createSessionPersistence();
    const result = store.reconnect("unknown", 0);
    expect(result.success).toBe(false);
    expect(result.missedMessages).toHaveLength(0);
  });

  it("reconnect fails for active (non-suspended) session", () => {
    const store = createSessionPersistence();
    store.save(makeSession());
    expect(store.reconnect("sess-1", 0).success).toBe(false);
  });

  it("reconnect fails for expired suspended session", () => {
    const clock = makeClock(BASE_TIME);
    const store = createSessionPersistence({ now: clock.now });
    store.save(makeSession());
    store.suspend("sess-1");
    clock.advance(SESSION_DEFAULTS.suspendWindowMs + 1);
    expect(store.reconnect("sess-1", 0).success).toBe(false);
  });

  it("reconnect from seq 0 returns all buffered messages", () => {
    const store = createSessionPersistence({ now: () => BASE_TIME });
    store.save(makeSession());
    store.addReplayMessage("sess-1", { type: "a" });
    store.addReplayMessage("sess-1", { type: "b" });
    store.addReplayMessage("sess-1", { type: "c" });
    store.suspend("sess-1");
    expect(store.reconnect("sess-1", 0).missedMessages).toHaveLength(3);
  });

  it("reconnect with partial seq returns only missed messages", () => {
    const store = createSessionPersistence({ now: () => BASE_TIME });
    store.save(makeSession());
    store.addReplayMessage("sess-1", { type: "a" }); // seq 1
    store.addReplayMessage("sess-1", { type: "b" }); // seq 2
    store.addReplayMessage("sess-1", { type: "c" }); // seq 3
    store.suspend("sess-1");
    const result = store.reconnect("sess-1", 2);
    expect(result.missedMessages).toHaveLength(1);
    expect(result.missedMessages[0]?.seq).toBe(3);
  });
});
