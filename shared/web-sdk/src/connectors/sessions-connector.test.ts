import { describe, expect, it, vi } from "vitest";
import { SessionsConnector } from "./sessions-connector.ts";

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
  };
};

describe("SessionsConnector", () => {
  it("list — sends frame, resolves on result with matching requestId", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.list({ limit: 20, offset: 0 });
    const sent = sdk.sent[0] as { requestId: string };
    sdk.emit("sessions.list.result", {
      requestId: sent.requestId,
      items: [],
      total: 0,
      hasMore: false,
    });
    await expect(p).resolves.toEqual({ items: [], total: 0, hasMore: false });
  });

  it("list — rejects on sessions.error matching requestId", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.list({ limit: 20, offset: 0 });
    const sent = sdk.sent[0] as { requestId: string };
    sdk.emit("sessions.error", { requestId: sent.requestId, code: "internal", message: "boom" });
    await expect(p).rejects.toThrow(/boom/);
  });

  it("delete — broadcasts SessionsChangeEvent on sessions.deleted", () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    const onChange = vi.fn();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    c.onSessionsChanged(onChange);
    sdk.emit("sessions.deleted", { sessionId: "s1" });
    expect(onChange).toHaveBeenCalledWith({ kind: "deleted", sessionId: "s1" });
  });

  it("delete — resolves on sessions.delete.result with matching requestId", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.delete("s1");
    const sent = sdk.sent[0] as { requestId: string };
    sdk.emit("sessions.delete.result", { requestId: sent.requestId, sessionId: "s1" });
    await expect(p).resolves.toBeUndefined();
  });

  it("rename — resolves on sessions.rename.result with matching requestId", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.rename("s1", "New Title");
    const sent = sdk.sent[0] as { requestId: string };
    sdk.emit("sessions.rename.result", {
      requestId: sent.requestId,
      sessionId: "s1",
      title: "New Title",
    });
    await expect(p).resolves.toBeUndefined();
  });

  it("rename — broadcasts SessionsChangeEvent on sessions.renamed", () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    const onChange = vi.fn();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    c.onSessionsChanged(onChange);
    sdk.emit("sessions.renamed", { sessionId: "s1", title: "Renamed" });
    expect(onChange).toHaveBeenCalledWith({ kind: "renamed", sessionId: "s1", title: "Renamed" });
  });

  it("switchTo — resolves on session.switched", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.switchTo("s1");
    sdk.emit("session.switched", { sessionId: "s1", ts: 1 });
    await expect(p).resolves.toBeUndefined();
  });

  it("newChat — resolves with sessionId on session.created", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.newChat();
    sdk.emit("session.created", { sessionId: "s2", ts: 1 });
    await expect(p).resolves.toEqual({ sessionId: "s2" });
  });

  it("request times out and rejects with timeout error", async () => {
    vi.useFakeTimers();
    try {
      const sdk = fakeSdk();
      const c = new SessionsConnector({ timeoutMs: 50 });
      c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
      const p = c.list({ limit: 20, offset: 0 });
      vi.advanceTimersByTime(60);
      await expect(p).rejects.toThrow(/timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
