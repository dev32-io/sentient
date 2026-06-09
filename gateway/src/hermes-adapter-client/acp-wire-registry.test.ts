import { describe, expect, it, vi } from "vitest";
import { type AcpWireHandle, createAcpWireRegistry } from "./acp-wire-registry.js";
import type { AcpPerProfileConnection } from "./per-profile-connection.js";

// ---------------------------------------------------------------------------
// AcpWireRegistry — wire/process-boundary contract: one pooled ACP wire per
// userId, ref-counted across PersonSession attachments. The overlay evicts a
// second same-profile connection with a clean 1000 close, so a second client
// MUST reuse the live wire instead of dialing. The dial fn / handle are mocked
// here — no real overlay is touched.
// ---------------------------------------------------------------------------

/** A stub handle: a sentinel acpConn + a spy dispose. */
function fakeHandle(tag: string): AcpWireHandle & { disposed: () => boolean } {
  let disposed = false;
  return {
    // Only identity matters to the registry; the real conn surface is unused here.
    acpConn: { __tag: tag } as unknown as AcpPerProfileConnection,
    dispose() {
      disposed = true;
    },
    disposed: () => disposed,
  };
}

/** A dial that resolves immediately to a fresh handle and counts invocations. */
function immediateDial(): { dial: () => Promise<AcpWireHandle>; calls: () => number; last: () => AcpWireHandle } {
  let count = 0;
  let lastHandle: AcpWireHandle = fakeHandle("unused");
  return {
    dial: () => {
      count += 1;
      lastHandle = fakeHandle(`wire-${count}`);
      return Promise.resolve(lastHandle);
    },
    calls: () => count,
    last: () => lastHandle,
  };
}

describe("AcpWireRegistry — ref-counted per-user pooling", () => {
  it("dials once and reuses the live wire on a second same-user acquire", async () => {
    const reg = createAcpWireRegistry();
    const d = immediateDial();

    const a = await reg.acquire("alice", d.dial);
    const b = await reg.acquire("alice", d.dial);

    expect(d.calls()).toBe(1);
    expect(a).toBe(b);
    expect(reg.refCount("alice")).toBe(2);
  });

  it("keeps the wire live after one release, disposes it on the last release", async () => {
    const reg = createAcpWireRegistry();
    const d = immediateDial();

    await reg.acquire("alice", d.dial);
    await reg.acquire("alice", d.dial);
    const handle = d.last() as AcpWireHandle & { disposed: () => boolean };

    reg.release("alice");
    expect(reg.refCount("alice")).toBe(1);
    expect(handle.disposed()).toBe(false);

    reg.release("alice");
    expect(reg.refCount("alice")).toBe(0);
    expect(handle.disposed()).toBe(true);
  });

  it("dials a separate wire per distinct userId", async () => {
    const reg = createAcpWireRegistry();
    const d = immediateDial();

    const a = await reg.acquire("alice", d.dial);
    const b = await reg.acquire("bob", d.dial);

    expect(d.calls()).toBe(2);
    expect(a).not.toBe(b);
    expect(reg.refCount("alice")).toBe(1);
    expect(reg.refCount("bob")).toBe(1);
  });

  it("collapses a concurrent first-acquire race into a single dial", async () => {
    const reg = createAcpWireRegistry();
    let resolveDial: ((h: AcpWireHandle) => void) | null = null;
    const dial = vi.fn(
      () =>
        new Promise<AcpWireHandle>((resolve) => {
          resolveDial = resolve;
        }),
    );

    // Two acquires fire BEFORE the dial resolves — both must await the same one.
    const p1 = reg.acquire("alice", dial);
    const p2 = reg.acquire("alice", dial);
    expect(dial).toHaveBeenCalledTimes(1);

    const handle = fakeHandle("shared");
    (resolveDial as unknown as (h: AcpWireHandle) => void)(handle);

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(c2);
    expect(c1).toBe(handle.acpConn);
    expect(reg.refCount("alice")).toBe(2);
  });

  it("drops the entry when the shared dial of a concurrent acquire rejects", async () => {
    const reg = createAcpWireRegistry();
    let rejectDial: ((e: Error) => void) | null = null;
    const dial = vi.fn(
      () =>
        new Promise<AcpWireHandle>((_resolve, reject) => {
          rejectDial = reject;
        }),
    );

    // Two acquires share one in-flight dial; the second is on the reuse branch
    // with refCount already bumped to 2 — then the shared dial REJECTS.
    const p1 = reg.acquire("alice", dial);
    const p2 = reg.acquire("alice", dial);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(reg.refCount("alice")).toBe(2);

    // Attach a real rejection handler to BOTH derived acquire promises BEFORE
    // firing reject(), capturing each error. This leaves NO transient
    // unhandled-rejection window for the Bun-native runner to flag, and the
    // raw mock dial promise's sole consumers are the registry's own awaits.
    const caught1 = p1.then(() => undefined).catch((e: unknown) => e);
    const caught2 = p2.then(() => undefined).catch((e: unknown) => e);

    (rejectDial as unknown as (e: Error) => void)(new Error("overlay unreachable"));

    // BOTH acquirers reject — neither sees a phantom live wire.
    const [err1, err2] = await Promise.all([caught1, caught2]);
    expect(err1).toBeInstanceOf(Error);
    expect((err1 as Error).message).toMatch(/overlay unreachable/);
    expect(err2).toBeInstanceOf(Error);
    expect((err2 as Error).message).toMatch(/overlay unreachable/);
    // No leaked ref: the poisoned entry is gone, not stuck at 2.
    expect(reg.refCount("alice")).toBe(0);

    // A later acquire RE-DIALS and succeeds — entry was dropped, not poisoned.
    const d = immediateDial();
    const conn = await reg.acquire("alice", d.dial);
    expect(d.calls()).toBe(1);
    expect(reg.refCount("alice")).toBe(1);
    expect(conn).toBeDefined();
  });

  it("drops the entry on a failed dial so a later acquire retries", async () => {
    const reg = createAcpWireRegistry();
    const failing = vi.fn(() => Promise.reject(new Error("overlay unreachable")));

    await expect(reg.acquire("alice", failing)).rejects.toThrow(/overlay unreachable/);
    expect(reg.refCount("alice")).toBe(0);

    // A later acquire must re-dial (no poisoned entry).
    const d = immediateDial();
    const conn = await reg.acquire("alice", d.dial);
    expect(d.calls()).toBe(1);
    expect(reg.refCount("alice")).toBe(1);
    expect(conn).toBeDefined();
  });

  it("release of an unknown user is a no-op", () => {
    const reg = createAcpWireRegistry();
    expect(() => reg.release("nobody")).not.toThrow();
    expect(reg.refCount("nobody")).toBe(0);
  });

  it("disposes a wire whose sole ref is released while the dial is still in flight", async () => {
    const reg = createAcpWireRegistry();
    let resolveDial: ((h: AcpWireHandle) => void) | null = null;
    const dial = (): Promise<AcpWireHandle> =>
      new Promise<AcpWireHandle>((resolve) => {
        resolveDial = resolve;
      });

    const acquirePromise = reg.acquire("alice", dial);
    // Release before the dial settles — refCount hits 0 with no handle yet.
    reg.release("alice");
    expect(reg.refCount("alice")).toBe(0);

    const handle = fakeHandle("late") as AcpWireHandle & { disposed: () => boolean };
    (resolveDial as unknown as (h: AcpWireHandle) => void)(handle);
    await acquirePromise;
    // Let the pending-dial dispose chain settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.disposed()).toBe(true);
  });
});
