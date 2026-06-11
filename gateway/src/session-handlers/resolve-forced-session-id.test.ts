import { describe, expect, it } from "vitest";
import { resolveForcedSessionId } from "./ws-session-configure.ts";

describe("resolveForcedSessionId", () => {
  it("returns the eager pending id (priority 1) without touching any promise", async () => {
    const id = await resolveForcedSessionId({
      pendingNewSessionId: "sess_prewarmed",
      pendingNewSessionPromise: null,
      cycleId: "cy1",
    });
    expect(id).toBe("sess_prewarmed");
  });

  it("awaits the in-flight session.new pre-warm Promise (priority 2)", async () => {
    const id = await resolveForcedSessionId({
      pendingNewSessionId: null,
      pendingNewSessionPromise: Promise.resolve("sess_prewarm_promise"),
      cycleId: "cy2",
    });
    expect(id).toBe("sess_prewarm_promise");
  });

  it("returns null when the pending promise rejects (no mint fallback)", async () => {
    const id = await resolveForcedSessionId({
      pendingNewSessionId: null,
      pendingNewSessionPromise: Promise.reject(new Error("acp-error")),
      cycleId: "cy3",
    });
    expect(id).toBeNull();
  });

  it("returns null on a fresh chain with no pending session.new (no gate-mint)", async () => {
    const id = await resolveForcedSessionId({
      pendingNewSessionId: null,
      pendingNewSessionPromise: null,
      cycleId: "cy4",
    });
    expect(id).toBeNull();
  });
});
