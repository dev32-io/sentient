import { describe, expect, it, vi } from "vitest";
import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.ts";
import { createSessionsHandlers } from "./sessions-handlers.ts";

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

const stubAcpConn = (overrides: Partial<AcpPerProfileConnection> = {}): AcpPerProfileConnection =>
  ({
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    newSession: async () => ({ sessionId: "sess_default" }),
    ...overrides,
  }) as unknown as AcpPerProfileConnection;

describe("SessionsHandlers — session.new", () => {
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
    });
    await h.handle({ type: "session.new", requestId: "r1" });
    expect(setPendingPromise).toHaveBeenCalledTimes(1);
    await expect(stashedPromise as unknown as Promise<string>).rejects.toThrow("acp boom");
    expect(setPending).not.toHaveBeenCalled();
    const err = send.mock.calls.find((c) => (c[0] as { type: string }).type === "sessions.error");
    expect(err?.[0]).toMatchObject({ requestId: "r1", code: "internal" });
  });
});

describe("SessionsHandlers — conversation.activate", () => {
  it("activate — guarded by ownership; calls switchFlow.switchTo and sets pending id on success", async () => {
    const switchTo = vi.fn(async () => {});
    const setPending = vi.fn();
    const send = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: { ...baseSwitchFlow, switchTo },
      profileSessionsLookup: async () => new Set(["a", "b"]),
      setPendingNewSessionId: setPending,
      acpConn: stubAcpConn(),
    });
    await h.handle({ type: "conversation.activate", sessionId: "a" });
    expect(switchTo).toHaveBeenCalledWith("a");
    expect(setPending).toHaveBeenCalledWith("a");
  });

  it("activate — cross-profile sessionId rejected with forbidden", async () => {
    const switchTo = vi.fn(async () => {});
    const send = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      titleStore: baseTitleStore,
      send,
      switchFlow: { ...baseSwitchFlow, switchTo },
      profileSessionsLookup: async () => new Set(["a", "b"]),
      acpConn: stubAcpConn(),
    });
    await h.handle({ type: "conversation.activate", sessionId: "z" });
    expect(switchTo).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "sessions.error",
      code: "forbidden",
    });
  });
});
