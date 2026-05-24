import { beforeEach, describe, expect, it } from "vitest";
import { ANONYMOUS_ROLE, ANONYMOUS_USER_ID, createSessionManager } from "./session-manager.ts";

describe("SessionManager", () => {
  let manager: ReturnType<typeof createSessionManager>;

  beforeEach(() => {
    manager = createSessionManager({ maxSessions: 10 });
  });

  it("creates an anonymous session", () => {
    const result = manager.createSession();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe(ANONYMOUS_USER_ID);
      expect(result.value.role).toBe(ANONYMOUS_ROLE);
      expect(result.value.sessionId).toBeTruthy();
    }
  });

  it("returns session by id", () => {
    const created = manager.createSession();
    if (!created.ok) throw new Error("Should create");

    const found = manager.getSession(created.value.sessionId);

    expect(found).toBeDefined();
    expect(found?.sessionId).toBe(created.value.sessionId);
  });

  it("returns undefined for unknown session id", () => {
    expect(manager.getSession("nonexistent")).toBeUndefined();
  });

  it("removes a session", () => {
    const created = manager.createSession();
    if (!created.ok) throw new Error("Should create");

    expect(manager.removeSession(created.value.sessionId)).toBe(true);
    expect(manager.getSession(created.value.sessionId)).toBeUndefined();
  });

  it("returns false when removing nonexistent session", () => {
    expect(manager.removeSession("nonexistent")).toBe(false);
  });

  it("returns active session count", () => {
    expect(manager.activeCount()).toBe(0);
    manager.createSession();
    manager.createSession();
    expect(manager.activeCount()).toBe(2);
  });

  it("enforces max session limit", () => {
    const small = createSessionManager({ maxSessions: 2 });
    small.createSession();
    small.createSession();
    const third = small.createSession();
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error).toContain("limit");
    }
  });

  it("allows new session after one is removed", () => {
    const small = createSessionManager({ maxSessions: 2 });
    const first = small.createSession();
    small.createSession();
    if (first.ok) small.removeSession(first.value.sessionId);

    const third = small.createSession();
    expect(third.ok).toBe(true);
  });

  it("enforces default 10-cap", () => {
    const defaultMgr = createSessionManager();
    for (let i = 0; i < 10; i++) {
      expect(defaultMgr.createSession().ok).toBe(true);
    }
    expect(defaultMgr.createSession().ok).toBe(false);
  });

  it("generates unique session ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = manager.createSession();
      if (r.ok) ids.add(r.value.sessionId);
    }
    expect(ids.size).toBe(10);
  });

  it("lists all active sessions", () => {
    manager.createSession();
    manager.createSession();
    expect(manager.listSessions()).toHaveLength(2);
  });
});
