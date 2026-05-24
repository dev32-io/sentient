import { describe, expect, it, vi } from "vitest";
import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.ts";
import type { SentientPluginClient } from "../hermes-adapter-client/plugin-client.ts";
import type { HermesSessionRow } from "../hermes-adapter-client/sessions-client.ts";
import { createSessionsHandlers } from "./sessions-handlers.ts";

const row = (id: string): HermesSessionRow => ({
  id,
  title: `t-${id}`,
  source: "sentient-user",
  started_at: 1_000,
  last_active: 2_000,
  ended_at: null,
  message_count: 1,
  is_active: false,
  parent_session_id: null,
});

const baseTitleStore = {
  getTitle: async (): Promise<string | undefined> => undefined,
  getTitlesFor: async (): Promise<Record<string, string>> => ({}),
  setTitle: async (): Promise<void> => {},
  delete: async (): Promise<void> => {},
};

const baseSwitchFlow = {
  state: "idle" as const,
  canAcceptUserMessage: (): boolean => true,
  switchTo: async (): Promise<void> => {},
};

const stubPluginClient = (overrides: Partial<SentientPluginClient> = {}): SentientPluginClient => ({
  search: async () => [],
  get: async () => null,
  getMessages: async () => [],
  delete: async () => {},
  ...overrides,
});

const stubAcpConn = (overrides: Partial<AcpPerProfileConnection> = {}): AcpPerProfileConnection =>
  ({
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    newSession: async () => ({ sessionId: "sess_default" }),
    ...overrides,
  }) as unknown as AcpPerProfileConnection;

describe("SessionsHandlers — list / rename / switch / new", () => {
  it("list — pulls from ACP and applies title overrides", async () => {
    const send = vi.fn();
    const acpConn = stubAcpConn({
      listSessions: async () => ({
        sessions: [
          { sessionId: "a", cwd: "/u", title: "Hello", updatedAt: "2026-05-07T10:00:00.000Z" },
          { sessionId: "b", cwd: "/u", title: "World", updatedAt: "2026-05-07T10:00:00.000Z" },
        ],
        nextCursor: null,
      }),
    });
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: { ...baseTitleStore, getTitlesFor: async () => ({ a: "Override A" }) },
      send,
      switchFlow: baseSwitchFlow,
      profileSessionsLookup: async () => new Set(["a", "b"]),
      acpConn,
      pluginClient: stubPluginClient(),
    });
    await h.handle({ type: "sessions.list", requestId: "r1", limit: 20, offset: 0 });
    const sent = send.mock.calls[0]?.[0];
    expect(sent.type).toBe("sessions.list.result");
    expect(sent.items[0]).toMatchObject({ sessionId: "a", title: "Override A" });
    expect(sent.items[1]).toMatchObject({ sessionId: "b", title: "World" });
  });

  it("delete — cross-profile sessionId rejected with forbidden", async () => {
    const send = vi.fn();
    const del = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: baseSwitchFlow,
      profileSessionsLookup: async () => new Set(["a", "b"]),
      acpConn: stubAcpConn(),
      pluginClient: stubPluginClient({ delete: del }),
    });
    await h.handle({ type: "sessions.delete", requestId: "r1", sessionId: "z" });
    expect(del).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "sessions.error",
      requestId: "r1",
      code: "forbidden",
    });
  });

  it("rename — writes to title store and emits both result + broadcast", async () => {
    const setTitle = vi.fn(async () => {});
    const send = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: { ...baseTitleStore, setTitle },
      send,
      switchFlow: baseSwitchFlow,
      profileSessionsLookup: async () => new Set(["a"]),
      acpConn: stubAcpConn(),
      pluginClient: stubPluginClient(),
    });
    await h.handle({ type: "sessions.rename", requestId: "r1", sessionId: "a", title: "Renamed" });
    expect(setTitle).toHaveBeenCalledWith("a", "Renamed");
    const result = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.rename.result");
    expect(result?.[0]).toMatchObject({ requestId: "r1", sessionId: "a", title: "Renamed" });
    const broadcast = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.renamed");
    expect(broadcast?.[0]).toMatchObject({ sessionId: "a", title: "Renamed" });
  });

  it("delete — emits both result + broadcast on success via plugin client", async () => {
    const send = vi.fn();
    const pluginDelete = vi.fn(async () => {});
    const titleDel = vi.fn(async () => {});
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: { ...baseTitleStore, delete: titleDel },
      send,
      switchFlow: baseSwitchFlow,
      profileSessionsLookup: async () => new Set(["a"]),
      acpConn: stubAcpConn(),
      pluginClient: stubPluginClient({ delete: pluginDelete }),
    });
    await h.handle({ type: "sessions.delete", requestId: "r1", sessionId: "a" });
    expect(pluginDelete).toHaveBeenCalledWith("a");
    expect(titleDel).toHaveBeenCalledWith("a");
    const result = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.delete.result");
    expect(result?.[0]).toMatchObject({ requestId: "r1", sessionId: "a" });
    const broadcast = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.deleted");
    expect(broadcast?.[0]).toMatchObject({ sessionId: "a" });
  });

  it("session.new — clears chat pane synchronously, kicks acpConn.newSession, and resolves with server-minted id", async () => {
    const send = vi.fn();
    const switchTo = vi.fn(async () => {});
    const setPending = vi.fn();
    let stashedPromise: Promise<string> | null = null;
    const setPendingPromise = vi.fn((p: Promise<string>) => {
      stashedPromise = p;
    });
    const newSession = vi.fn(async () => ({ sessionId: "sess_acp_minted" }));
    const acpConn = stubAcpConn({ newSession });
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: { ...baseSwitchFlow, switchTo },
      profileSessionsLookup: async () => new Set(),
      setPendingNewSessionId: setPending,
      setPendingNewSessionPromise: setPendingPromise,
      acpConn,
      pluginClient: stubPluginClient(),
    });
    // handle() returns once switchTo("") resolves and the kicked Promise has
    // been stashed — pre-warm contract.
    await h.handle({ type: "session.new", requestId: "r1" });
    expect(switchTo).toHaveBeenCalledWith("");
    expect(setPendingPromise).toHaveBeenCalledTimes(1);
    expect(stashedPromise).not.toBeNull();
    // Resolution side effects (setPendingNewSessionId + session.created)
    // happen once the kicked Promise resolves.
    const sessionId = await (stashedPromise as unknown as Promise<string>);
    expect(sessionId).toBe("sess_acp_minted");
    expect(newSession).toHaveBeenCalledWith({});
    expect(setPending).toHaveBeenCalledWith("sess_acp_minted");
    const created = send.mock.calls.find((c) => (c[0] as { type: string }).type === "session.created");
    expect(created?.[0]).toMatchObject({ sessionId: "sess_acp_minted" });
    expect((created?.[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it("session.new — kicked Promise rejects and emits sessions.error when ACP newSession fails", async () => {
    const send = vi.fn();
    const setPending = vi.fn();
    let stashedPromise: Promise<string> | null = null;
    const setPendingPromise = vi.fn((p: Promise<string>) => {
      stashedPromise = p;
      // Attach a no-op catch so the test runner doesn't see an unhandled
      // rejection from the explicit `expect(...).rejects` below racing the
      // handler's internal `.catch(() => {})`.
      p.catch(() => {});
    });
    const newSession = vi.fn(async () => {
      throw new Error("acp boom");
    });
    const acpConn = stubAcpConn({ newSession });
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: baseSwitchFlow,
      profileSessionsLookup: async () => new Set(),
      setPendingNewSessionId: setPending,
      setPendingNewSessionPromise: setPendingPromise,
      acpConn,
      pluginClient: stubPluginClient(),
    });
    await h.handle({ type: "session.new", requestId: "r1" });
    expect(setPendingPromise).toHaveBeenCalledTimes(1);
    await expect(stashedPromise as unknown as Promise<string>).rejects.toThrow("acp boom");
    expect(setPending).not.toHaveBeenCalled();
    const err = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.error");
    expect(err?.[0]).toMatchObject({ requestId: "r1", code: "internal" });
  });

  it("switch — guarded by ownership; calls switchFlow.switchTo on success", async () => {
    const switchTo = vi.fn(async () => {});
    const send = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: { ...baseSwitchFlow, switchTo },
      profileSessionsLookup: async () => new Set(["a", "b"]),
      acpConn: stubAcpConn(),
      pluginClient: stubPluginClient(),
    });
    await h.handle({ type: "session.switch", requestId: "r1", sessionId: "a" });
    expect(switchTo).toHaveBeenCalledWith("a");
  });
});

describe("SessionsHandlers — search routes through plugin client", () => {
  it("search — enriches hits via plugin.get + filters by ownership", async () => {
    const send = vi.fn();
    const pluginSearch = vi.fn(async () => [
      { session_id: "a", snippet: "snip", role: "user", source: "sentient", model: "gpt", session_started: 1 },
      { session_id: "z", snippet: "snip", role: "user", source: "sentient", model: "gpt", session_started: 1 },
    ]);
    const pluginGet = vi.fn(async () => row("a"));
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: baseSwitchFlow,
      profileSessionsLookup: async () => new Set(["a"]),
      acpConn: stubAcpConn(),
      pluginClient: stubPluginClient({ search: pluginSearch, get: pluginGet }),
    });
    await h.handle({ type: "sessions.search", requestId: "r1", q: "foo", limit: 10 });
    expect(pluginSearch).toHaveBeenCalledWith("foo", 10);
    expect(pluginGet).toHaveBeenCalledWith("a");
    const result = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.search.result");
    expect((result?.[0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it("delete — plugin 404 maps to not_found error frame", async () => {
    const send = vi.fn();
    class StubError extends Error {
      readonly status = 404;
    }
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: baseSwitchFlow,
      profileSessionsLookup: async () => new Set(["a"]),
      acpConn: stubAcpConn(),
      pluginClient: stubPluginClient({
        delete: async () => {
          throw new StubError("missing");
        },
      }),
    });
    await h.handle({ type: "sessions.delete", requestId: "r1", sessionId: "a" });
    const err = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.error");
    expect(err?.[0]).toMatchObject({ requestId: "r1", code: "not_found" });
  });
});
