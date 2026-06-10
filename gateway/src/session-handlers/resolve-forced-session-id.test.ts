import { describe, expect, it, vi } from "vitest";
import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.ts";
import { resolveForcedSessionId } from "./ws-session-configure.ts";

const stubAcpConn = (overrides: Partial<AcpPerProfileConnection> = {}): AcpPerProfileConnection =>
  ({
    newSession: async () => ({ sessionId: "sess_gate_minted" }),
    ...overrides,
  }) as unknown as AcpPerProfileConnection;

const GATE_TIMEOUT = 5000;

describe("resolveForcedSessionId — gate fresh-chain mint (Fix A)", () => {
  it("mints + broadcasts session.created on a fresh chain when NO client session.new was sent", async () => {
    const wsSend = vi.fn();
    const setPending = vi.fn();
    const newSession = vi.fn(async () => ({ sessionId: "sess_gate_minted" }));
    const id = await resolveForcedSessionId({
      pendingNewSessionId: null,
      pendingNewSessionPromise: null,
      conversationId: null, // fresh chain
      acpConn: stubAcpConn({ newSession }),
      wsSend,
      setPendingNewSessionId: setPending,
      gateMintTimeoutMs: GATE_TIMEOUT,
      cycleId: "cy1",
    });
    // The cycle dispatches on the minted id — not a separate lazy id.
    expect(id).toBe("sess_gate_minted");
    expect(newSession).toHaveBeenCalledWith({});
    // Client receives session.created for the new chat even with no session.new.
    const created = wsSend.mock.calls.find((c) => (c[0] as { type: string }).type === "session.created");
    expect(created?.[0]).toMatchObject({ type: "session.created", sessionId: "sess_gate_minted" });
    // Pending id stashed so turn-2 reuse falls back to it / binding.conversationId.
    expect(setPending).toHaveBeenCalledWith("sess_gate_minted");
  });

  it("uses the eager pending id and does NOT mint or emit session.created (no double-mint)", async () => {
    const wsSend = vi.fn();
    const setPending = vi.fn();
    const newSession = vi.fn(async () => ({ sessionId: "sess_should_not_mint" }));
    const id = await resolveForcedSessionId({
      pendingNewSessionId: "sess_prewarmed",
      pendingNewSessionPromise: null,
      conversationId: null,
      acpConn: stubAcpConn({ newSession }),
      wsSend,
      setPendingNewSessionId: setPending,
      gateMintTimeoutMs: GATE_TIMEOUT,
      cycleId: "cy2",
    });
    expect(id).toBe("sess_prewarmed");
    expect(newSession).not.toHaveBeenCalled();
    expect(wsSend).not.toHaveBeenCalled();
  });

  it("awaits the in-flight session.new pre-warm Promise without minting again", async () => {
    const wsSend = vi.fn();
    const newSession = vi.fn(async () => ({ sessionId: "sess_should_not_mint" }));
    const id = await resolveForcedSessionId({
      pendingNewSessionId: null,
      pendingNewSessionPromise: Promise.resolve("sess_prewarm_promise"),
      conversationId: null,
      acpConn: stubAcpConn({ newSession }),
      wsSend,
      setPendingNewSessionId: vi.fn(),
      gateMintTimeoutMs: GATE_TIMEOUT,
      cycleId: "cy3",
    });
    expect(id).toBe("sess_prewarm_promise");
    expect(newSession).not.toHaveBeenCalled();
    expect(wsSend).not.toHaveBeenCalled();
  });

  it("returns null on an established chain (binding.conversationId set) — no mint, Hermes keying takes over", async () => {
    const wsSend = vi.fn();
    const newSession = vi.fn(async () => ({ sessionId: "sess_should_not_mint" }));
    const id = await resolveForcedSessionId({
      pendingNewSessionId: null,
      pendingNewSessionPromise: null,
      conversationId: "sess_existing", // turn 2+
      acpConn: stubAcpConn({ newSession }),
      wsSend,
      setPendingNewSessionId: vi.fn(),
      gateMintTimeoutMs: GATE_TIMEOUT,
      cycleId: "cy4",
    });
    expect(id).toBeNull();
    expect(newSession).not.toHaveBeenCalled();
    expect(wsSend).not.toHaveBeenCalled();
  });

  it("returns null (backstop) when the gate mint never settles — does not hang the first message", async () => {
    const wsSend = vi.fn();
    const setPending = vi.fn();
    const id = await resolveForcedSessionId({
      pendingNewSessionId: null,
      pendingNewSessionPromise: null,
      conversationId: null,
      acpConn: stubAcpConn({ newSession: () => new Promise<{ sessionId: string }>(() => {}) }),
      wsSend,
      setPendingNewSessionId: setPending,
      gateMintTimeoutMs: 20,
      cycleId: "cy5",
    });
    expect(id).toBeNull();
    expect(setPending).not.toHaveBeenCalled();
    expect(wsSend).not.toHaveBeenCalled();
  });
});
