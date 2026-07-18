import { describe, expect, it, vi } from "vitest";
import { type AcpWireHandle, createAcpWireRegistry } from "./acp-wire-registry.js";
import type { AcpPerProfileConnection } from "./per-profile-connection.js";

// ---------------------------------------------------------------------------
// AcpWireRegistry — wire/process-boundary contract: one pooled ACP wire per
// surfaceId (chat tab / app instance), ref-counted across that surface's
// reconnects. The overlay spawns a fresh child per connection so per-surface
// wires are fully isolated; a surface's reconnect reuses the warm child.
// The dial fn / handle are mocked here — no real overlay is touched.
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

describe("AcpWireRegistry — ref-counted per-surface pooling", () => {
  it("dials once and reuses the live wire on a second same-surface acquire", async () => {
    const reg = createAcpWireRegistry();
    const d = immediateDial();

    const a = await reg.acquire("surface-alice", d.dial);
    const b = await reg.acquire("surface-alice", d.dial);

    expect(d.calls()).toBe(1);
    expect(a).toBe(b);
    expect(reg.refCount("surface-alice")).toBe(2);
  });

  it("keeps the wire live after one release, disposes it on the last release", async () => {
    const reg = createAcpWireRegistry();
    const d = immediateDial();

    await reg.acquire("surface-alice", d.dial);
    await reg.acquire("surface-alice", d.dial);
    const handle = d.last() as AcpWireHandle & { disposed: () => boolean };

    reg.release("surface-alice");
    expect(reg.refCount("surface-alice")).toBe(1);
    expect(handle.disposed()).toBe(false);

    reg.release("surface-alice");
    expect(reg.refCount("surface-alice")).toBe(0);
    expect(handle.disposed()).toBe(true);
  });

  it("dials a separate wire per distinct surfaceId", async () => {
    const reg = createAcpWireRegistry();
    const d = immediateDial();

    const a = await reg.acquire("surface-1", d.dial);
    const b = await reg.acquire("surface-2", d.dial);

    expect(d.calls()).toBe(2);
    expect(a).not.toBe(b);
  });

  it("dials TWO isolated wires for two surfaces of the SAME user (no cross-surface fork)", async () => {
    const reg = createAcpWireRegistry();
    const d = immediateDial();
    const tabA = await reg.acquire("alice-tab-A", d.dial);
    const tabB = await reg.acquire("alice-tab-B", d.dial);
    expect(d.calls()).toBe(2);
    expect(tabA).not.toBe(tabB);
    reg.release("alice-tab-A");
    expect(reg.refCount("alice-tab-A")).toBe(0);
    expect(reg.refCount("alice-tab-B")).toBe(1);
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
    const p1 = reg.acquire("surface-alice", dial);
    const p2 = reg.acquire("surface-alice", dial);
    expect(dial).toHaveBeenCalledTimes(1);

    const handle = fakeHandle("shared");
    (resolveDial as unknown as (h: AcpWireHandle) => void)(handle);

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(c2);
    expect(c1).toBe(handle.acpConn);
    expect(reg.refCount("surface-alice")).toBe(2);
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
    const p1 = reg.acquire("surface-alice", dial);
    const p2 = reg.acquire("surface-alice", dial);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(reg.refCount("surface-alice")).toBe(2);

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
    expect(reg.refCount("surface-alice")).toBe(0);

    // A later acquire RE-DIALS and succeeds — entry was dropped, not poisoned.
    const d = immediateDial();
    const conn = await reg.acquire("surface-alice", d.dial);
    expect(d.calls()).toBe(1);
    expect(reg.refCount("surface-alice")).toBe(1);
    expect(conn).toBeDefined();
  });

  it("drops the entry on a failed dial so a later acquire retries", async () => {
    const reg = createAcpWireRegistry();
    const failing = vi.fn(() => Promise.reject(new Error("overlay unreachable")));

    await expect(reg.acquire("surface-alice", failing)).rejects.toThrow(/overlay unreachable/);
    expect(reg.refCount("surface-alice")).toBe(0);

    // A later acquire must re-dial (no poisoned entry).
    const d = immediateDial();
    const conn = await reg.acquire("surface-alice", d.dial);
    expect(d.calls()).toBe(1);
    expect(reg.refCount("surface-alice")).toBe(1);
    expect(conn).toBeDefined();
  });

  it("release of an unknown surfaceId is a no-op", () => {
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

    const acquirePromise = reg.acquire("surface-alice", dial);
    // Release before the dial settles — refCount hits 0 with no handle yet.
    reg.release("surface-alice");
    expect(reg.refCount("surface-alice")).toBe(0);

    const handle = fakeHandle("late") as AcpWireHandle & { disposed: () => boolean };
    (resolveDial as unknown as (h: AcpWireHandle) => void)(handle);
    await acquirePromise;
    // Let the pending-dial dispose chain settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.disposed()).toBe(true);
  });

  it("hasLiveWires reflects pooled entries", async () => {
    const reg = createAcpWireRegistry("u_00000001");
    expect(reg.hasLiveWires()).toBe(false);
    const handle = { acpConn: {} as never, dispose: () => {} };
    await reg.acquire("surface-a", async () => handle);
    expect(reg.hasLiveWires()).toBe(true);
    reg.release("surface-a");
    expect(reg.hasLiveWires()).toBe(false);
  });

  it("disposeAll force-disposes every pooled handle and clears the pool", async () => {
    const reg = createAcpWireRegistry("u_00000001");
    let disposedA = 0;
    let disposedB = 0;
    await reg.acquire("a", async () => ({
      acpConn: {} as never,
      dispose: () => {
        disposedA++;
      },
    }));
    await reg.acquire("b", async () => ({
      acpConn: {} as never,
      dispose: () => {
        disposedB++;
      },
    }));
    reg.disposeAll();
    expect(disposedA).toBe(1);
    expect(disposedB).toBe(1);
    expect(reg.hasLiveWires()).toBe(false);
  });

  it("disposeAll clears the pool even when an unresolved dial is pending", async () => {
    const reg = createAcpWireRegistry("u_00000001");
    let disposed = 0;
    let resolveDial: ((h: AcpWireHandle) => void) | null = null;
    const dial = (): Promise<AcpWireHandle> =>
      new Promise<AcpWireHandle>((resolve) => {
        resolveDial = resolve;
      });

    // Acquire with an unresolved dial — entry is pooled but handle is null.
    const acquirePromise = reg.acquire("pending-surface", dial);
    expect(reg.hasLiveWires()).toBe(true);

    // disposeAll should clear the pool even with pending-dial branches.
    reg.disposeAll();
    expect(reg.hasLiveWires()).toBe(false);

    // Eventually resolve the pending dial and attach a dispose tracker.
    const handle = {
      acpConn: {} as never,
      dispose: () => {
        disposed++;
      },
    };
    (resolveDial as unknown as (h: AcpWireHandle) => void)(handle);
    await acquirePromise;
    // Let the pending-dial dispose chain settle.
    await Promise.resolve();
    await Promise.resolve();
    // The pending-dial branch in disposeAll should have disposed it.
    expect(disposed).toBe(1);
  });

  it("disposeAll continues disposing remaining entries even if one throws", async () => {
    const reg = createAcpWireRegistry("u_00000001");
    let disposedA = 0;
    let disposedC = 0;

    await reg.acquire("a", async () => ({
      acpConn: {} as never,
      dispose: () => {
        disposedA++;
      },
    }));
    await reg.acquire("b", async () => ({
      acpConn: {} as never,
      dispose: () => {
        throw new Error("dispose-failure");
      },
    }));
    await reg.acquire("c", async () => ({
      acpConn: {} as never,
      dispose: () => {
        disposedC++;
      },
    }));

    // disposeAll should not throw; it should log and continue.
    expect(() => reg.disposeAll()).not.toThrow();

    // Entries a and c should be disposed; b threw but was skipped.
    expect(disposedA).toBe(1);
    expect(disposedC).toBe(1);

    // Pool must be cleared even if one entry's dispose threw.
    expect(reg.hasLiveWires()).toBe(false);
  });
});
