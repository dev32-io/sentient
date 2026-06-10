import { describe, expect, it, vi } from "vitest";
import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.ts";
import type { Log } from "../logging/logger.ts";
import { mintAndAnnounceSession } from "./mint-and-announce-session.ts";

const stubLog = (): Log => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const stubAcpConn = (overrides: Partial<AcpPerProfileConnection> = {}): AcpPerProfileConnection =>
  ({
    newSession: async () => ({ sessionId: "sess_minted" }),
    ...overrides,
  }) as unknown as AcpPerProfileConnection;

describe("mintAndAnnounceSession", () => {
  it("mints a session, stashes the pending id, and emits session.created to the client", async () => {
    const send = vi.fn();
    const setPending = vi.fn();
    const newSession = vi.fn(async () => ({ sessionId: "sess_minted" }));
    const id = await mintAndAnnounceSession({
      acpConn: stubAcpConn({ newSession }),
      send,
      setPendingNewSessionId: setPending,
      log: stubLog(),
      reason: "gate-fresh-chain",
    });
    expect(id).toBe("sess_minted");
    expect(newSession).toHaveBeenCalledWith({});
    expect(setPending).toHaveBeenCalledWith("sess_minted");
    const created = send.mock.calls.find((c) => (c[0] as { type: string }).type === "session.created");
    expect(created?.[0]).toMatchObject({ type: "session.created", sessionId: "sess_minted" });
    expect((created?.[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it("returns null and does NOT emit session.created when newSession fails", async () => {
    const send = vi.fn();
    const setPending = vi.fn();
    const log = stubLog();
    const id = await mintAndAnnounceSession({
      acpConn: stubAcpConn({
        newSession: async () => {
          throw new Error("acp boom");
        },
      }),
      send,
      setPendingNewSessionId: setPending,
      log,
      reason: "gate-fresh-chain",
    });
    expect(id).toBeNull();
    expect(setPending).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns null when the mint does not settle within timeoutMs (backstop)", async () => {
    const send = vi.fn();
    const setPending = vi.fn();
    const log = stubLog();
    const id = await mintAndAnnounceSession({
      acpConn: stubAcpConn({
        // Never settles — exercises the timeout race.
        newSession: () => new Promise<{ sessionId: string }>(() => {}),
      }),
      send,
      setPendingNewSessionId: setPending,
      log,
      reason: "gate-fresh-chain",
      timeoutMs: 20,
    });
    expect(id).toBeNull();
    expect(setPending).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
