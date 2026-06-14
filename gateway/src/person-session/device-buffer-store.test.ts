import { describe, expect, it, vi } from "vitest";
import { DeviceBufferStore } from "./device-buffer-store.js";

const BUFFER_MAX_BYTES = 1024 * 64; // 64 KB — small for tests

function makeStore(): DeviceBufferStore {
  return new DeviceBufferStore(BUFFER_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// DeviceBufferStore
// ---------------------------------------------------------------------------

describe("DeviceBufferStore", () => {
  it("acquire returns resumed:false and epoch 1 on first call", () => {
    const store = makeStore();
    const result = store.acquire("surf-A", { deviceId: "dev-A" });
    expect(result.resumed).toBe(false);
    expect(result.epoch).toBe(1);
    expect(result.buffer).toBeDefined();
    expect(result.clock).toBeDefined();
  });

  it("acquire resumes the same buffer when resumeEpoch matches", () => {
    const store = makeStore();
    const first = store.acquire("surf-A", { deviceId: "dev-A" });
    store.release("surf-A");
    const second = store.acquire("surf-A", { deviceId: "dev-A", resumeEpoch: first.epoch });
    expect(second.resumed).toBe(true);
    expect(second.epoch).toBe(first.epoch);
    expect(second.buffer).toBe(first.buffer);
  });

  it("acquire creates a fresh buffer when resumeEpoch does not match", () => {
    const store = makeStore();
    const first = store.acquire("surf-A", { deviceId: "dev-A" });
    store.release("surf-A");
    const second = store.acquire("surf-A", { deviceId: "dev-A", resumeEpoch: 999 });
    expect(second.resumed).toBe(false);
    expect(second.epoch).toBe(2);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("acquire with no resumeEpoch on an EXISTING entry returns a fresh buffer + new epoch", () => {
    const store = makeStore();
    const first = store.acquire("surf-A", { deviceId: "dev-A" });
    store.release("surf-A");
    // No resumeEpoch — undefined never matches a real epoch number.
    const second = store.acquire("surf-A", { deviceId: "dev-A" });
    expect(second.resumed).toBe(false);
    expect(second.epoch).toBe(2);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("acquire creates independent buffers per surfaceId", () => {
    const store = makeStore();
    const a = store.acquire("surf-A", { deviceId: "dev-A" });
    const b = store.acquire("surf-B", { deviceId: "dev-B" });
    expect(a.buffer).not.toBe(b.buffer);
    expect(a.epoch).toBe(1);
    expect(b.epoch).toBe(2);
  });

  it("gives two surfaces of the SAME device independent buffers + epochs", () => {
    const store = makeStore();
    const tabA = store.acquire("surf-A", { deviceId: "browser-1" });
    const tabB = store.acquire("surf-B", { deviceId: "browser-1" });
    expect(tabA.buffer).not.toBe(tabB.buffer);
    expect(tabA.epoch).not.toBe(tabB.epoch);
  });

  it("carries deviceId on the entry for device-presence", () => {
    const store = makeStore();
    store.acquire("surf-A", { deviceId: "dev-A" });
    expect(store.deviceIdFor("surf-A")).toBe("dev-A");
  });

  it("retains the carried deviceId across a resumed acquire", () => {
    const store = makeStore();
    const first = store.acquire("surf-A", { deviceId: "dev-A" });
    store.release("surf-A");
    store.acquire("surf-A", { deviceId: "dev-A", resumeEpoch: first.epoch });
    expect(store.deviceIdFor("surf-A")).toBe("dev-A");
  });

  it("bufferFor and epochFor return the active entry values", () => {
    const store = makeStore();
    const { buffer, epoch } = store.acquire("surf-A", { deviceId: "dev-A" });
    expect(store.bufferFor("surf-A")).toBe(buffer);
    expect(store.epochFor("surf-A")).toBe(epoch);
  });

  it("bufferFor and epochFor return undefined for unknown surfaceId", () => {
    const store = makeStore();
    expect(store.bufferFor("unknown")).toBeUndefined();
    expect(store.epochFor("unknown")).toBeUndefined();
  });

  it("hasRetainedBuffers is false before any acquire, true after", () => {
    const store = makeStore();
    expect(store.hasRetainedBuffers()).toBe(false);
    store.acquire("surf-A", { deviceId: "dev-A" });
    expect(store.hasRetainedBuffers()).toBe(true);
  });

  it("hasRetainedBuffers returns true for a currently-attached (not yet released) surface", () => {
    const store = makeStore();
    store.acquire("surf-A", { deviceId: "dev-A" }); // acquired but NOT released — still attached
    // An attached surface blocks eviction just like a detached-but-within-TTL one.
    expect(store.hasRetainedBuffers()).toBe(true);
  });

  it("evicts a detached idle buffer past the window, running deferred teardown", () => {
    const store = new DeviceBufferStore(1024);
    store.acquire("surf-1", { deviceId: "dev-1" });
    const td = vi.fn();
    store.release("surf-1", td);
    const removed = store.sweepIdle(Date.now() + 900_000, 900_000);
    expect(removed).toBe(1);
    expect(td).toHaveBeenCalledTimes(1);
  });

  it("force-closes a still-attached but idle buffer (ping-keepalive), without removing it here", () => {
    const store = new DeviceBufferStore(1024);
    store.acquire("surf-1", { deviceId: "dev-1" }); // attached (detachedAtMs === null)
    const fc = vi.fn();
    store.setForceClose("surf-1", fc);
    const removed = store.sweepIdle(Date.now() + 900_000, 900_000);
    expect(fc).toHaveBeenCalledTimes(1);
    expect(removed).toBe(0);
  });

  it("keeps a buffer whose clock was recently touched", () => {
    const store = new DeviceBufferStore(1024);
    const acq = store.acquire("surf-1", { deviceId: "dev-1" });
    // Touch resets lastActivityMs to Date.now() at that instant.
    acq.clock.touch("acp.in");
    // Use a nowMs just 1 second after the touch — well under the 900s window.
    const justAfterTouch = acq.clock.lastActivityMs() + 1_000;
    expect(store.sweepIdle(justAfterTouch, 900_000)).toBe(0);
  });

  it("release warns on unknown surfaceId (no throw)", () => {
    const store = makeStore();
    // Should not throw — just a warn log.
    expect(() => store.release("ghost")).not.toThrow();
  });

  it("reuses the same activity clock across a resumed acquire", () => {
    const store = new DeviceBufferStore(1024);
    const first = store.acquire("surf-1", { deviceId: "dev-1" });
    const resumed = store.acquire("surf-1", { deviceId: "dev-1", resumeEpoch: first.epoch });
    expect(resumed.resumed).toBe(true);
    expect(resumed.clock).toBe(first.clock);
  });
});
