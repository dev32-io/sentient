import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult, SessionsRest } from "../sessions-rest.ts";
import { SessionsConnector } from "./sessions-connector.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const fakeSdk = () => {
  const handlers: Record<string, ((m: unknown) => void)[]> = {};
  const sent: Record<string, unknown>[] = [];
  return {
    onMessage(type: string, fn: (m: unknown) => void) {
      const list = handlers[type] ?? [];
      list.push(fn);
      handlers[type] = list;
      return () => {};
    },
    send(msg: Record<string, unknown>) {
      sent.push(msg);
    },
    emit(type: string, msg: unknown) {
      for (const h of handlers[type] ?? []) h(msg);
    },
    sent,
    sendBinary: vi.fn(),
    onBinary: vi.fn(() => () => {}),
  };
};

const makeRow = (id: string) => ({
  sessionId: id,
  rootId: id,
  title: "T",
  startedAt: 1,
  lastActiveAt: 1,
  messageCount: 0,
  isActive: false,
});

const makeRest = (overrides: Partial<SessionsRest> = {}): SessionsRest => ({
  list: vi.fn(async () => ({ items: [], total: 0, hasMore: false }) as SessionsListResult),
  search: vi.fn(async () => []),
  getMessages: vi.fn(async () => []),
  rename: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionsConnector", () => {
  it("list — delegates to REST client with default opts", async () => {
    const sdk = fakeSdk();
    const rest = makeRest({
      list: vi.fn(async () => ({ items: [makeRow("s-1")], total: 1, hasMore: false })),
    });
    const c = new SessionsConnector({ rest });
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const result = await c.list();
    expect(result.items[0]?.sessionId).toBe("s-1");
    expect(rest.list).toHaveBeenCalledWith({});
  });

  it("list — passes limit and offset to REST", async () => {
    const sdk = fakeSdk();
    const rest = makeRest();
    const c = new SessionsConnector({ rest });
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    await c.list({ limit: 20, offset: 10 });
    expect(rest.list).toHaveBeenCalledWith({ limit: 20, offset: 10 });
  });

  it("search — delegates to REST client", async () => {
    const sdk = fakeSdk();
    const row = makeRow("s-2");
    const rest = makeRest({ search: vi.fn(async () => [row]) });
    const c = new SessionsConnector({ rest });
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const items = await c.search("hello", 10);
    expect(items).toEqual([row]);
    expect(rest.search).toHaveBeenCalledWith("hello", 10);
  });

  it("delete — calls REST and dispatches deleted change event", async () => {
    const sdk = fakeSdk();
    const rest = makeRest();
    const c = new SessionsConnector({ rest });
    const onChange = vi.fn();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    c.onSessionsChanged(onChange);
    await c.delete("s-1");
    expect(rest.delete).toHaveBeenCalledWith("s-1");
    expect(onChange).toHaveBeenCalledWith({ kind: "deleted", sessionId: "s-1" });
  });

  it("rename — calls REST and dispatches renamed change event", async () => {
    const sdk = fakeSdk();
    const rest = makeRest();
    const c = new SessionsConnector({ rest });
    const onChange = vi.fn();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    c.onSessionsChanged(onChange);
    await c.rename("s-1", "New Title");
    expect(rest.rename).toHaveBeenCalledWith("s-1", "New Title");
    expect(onChange).toHaveBeenCalledWith({ kind: "renamed", sessionId: "s-1", title: "New Title" });
  });

  it("delete — does not dispatch change event if REST rejects", async () => {
    const sdk = fakeSdk();
    const rest = makeRest({
      delete: vi.fn(async () => {
        throw new Error("not found");
      }),
    });
    const c = new SessionsConnector({ rest });
    const onChange = vi.fn();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    c.onSessionsChanged(onChange);
    await expect(c.delete("s-1")).rejects.toThrow("not found");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("switchTo — sends conversation.activate (not session.switch) over WS", async () => {
    const sdk = fakeSdk();
    const rest = makeRest();
    const c = new SessionsConnector({ rest });
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.switchTo("s-1");
    // Must send conversation.activate, not session.switch
    expect(sdk.sent[0]).toMatchObject({ type: "conversation.activate", sessionId: "s-1" });
    expect(sdk.sent[0]).not.toMatchObject({ type: "session.switch" });
    sdk.emit("session.switched", { sessionId: "s-1", ts: 1 });
    await expect(p).resolves.toBeUndefined();
  });

  it("switchTo — dispatches switched change event on session.switched", async () => {
    const sdk = fakeSdk();
    const rest = makeRest();
    const c = new SessionsConnector({ rest });
    const onChange = vi.fn();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    c.onSessionsChanged(onChange);
    const p = c.switchTo("s-1");
    sdk.emit("session.switched", { sessionId: "s-1", ts: 42 });
    await p;
    expect(onChange).toHaveBeenCalledWith({ kind: "switched", sessionId: "s-1", ts: 42 });
  });

  it("newChat — resolves with sessionId on session.created", async () => {
    const sdk = fakeSdk();
    const rest = makeRest();
    const c = new SessionsConnector({ rest });
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.newChat();
    sdk.emit("session.created", { sessionId: "s-new", ts: 1 });
    await expect(p).resolves.toEqual({ sessionId: "s-new" });
  });

  it("switchTo — rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const sdk = fakeSdk();
      const rest = makeRest();
      const c = new SessionsConnector({ rest, timeoutMs: 50 });
      c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
      const p = c.switchTo("s-1");
      vi.advanceTimersByTime(60);
      await expect(p).rejects.toThrow(/timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
