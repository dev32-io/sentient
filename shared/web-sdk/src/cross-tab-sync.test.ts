import { describe, expect, it, vi } from "vitest";
import { createCrossTabSync } from "./cross-tab-sync.ts";

describe("CrossTabSync", () => {
  it("broadcast → listen on a sibling channel of the same name", async () => {
    const a = createCrossTabSync({ userId: "u1" });
    const b = createCrossTabSync({ userId: "u1" });
    const seen = vi.fn();
    b.onEvent(seen);
    a.broadcast({ kind: "deleted", sessionId: "s1" });
    // BroadcastChannel delivers asynchronously; allow a microtask flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveBeenCalledWith({ kind: "deleted", sessionId: "s1" });
    a.dispose();
    b.dispose();
  });

  it("dispose unsubscribes", async () => {
    const a = createCrossTabSync({ userId: "u1" });
    const b = createCrossTabSync({ userId: "u1" });
    const seen = vi.fn();
    b.onEvent(seen);
    b.dispose();
    a.broadcast({ kind: "renamed", sessionId: "s1", title: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toHaveBeenCalled();
    a.dispose();
  });

  it("ignores messages on a different userId", async () => {
    const a = createCrossTabSync({ userId: "u1" });
    const b = createCrossTabSync({ userId: "u2" });
    const seen = vi.fn();
    b.onEvent(seen);
    a.broadcast({ kind: "deleted", sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toHaveBeenCalled();
    a.dispose();
    b.dispose();
  });
});
