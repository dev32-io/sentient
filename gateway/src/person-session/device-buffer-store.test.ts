import { describe, expect, it } from "vitest";
import { DeviceBufferStore, shouldEvictDeviceBuffer } from "./device-buffer-store.js";

const BUFFER_MAX_BYTES = 1024 * 64; // 64 KB — small for tests
const TTL_MS = 30_000; // 30 s for tests

function makeStore(): DeviceBufferStore {
  return new DeviceBufferStore(BUFFER_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// shouldEvictDeviceBuffer truth table
// ---------------------------------------------------------------------------

describe("shouldEvictDeviceBuffer", () => {
  it("returns false when detachedAtMs is null (still attached)", () => {
    expect(shouldEvictDeviceBuffer(null, 9_999_999, TTL_MS)).toBe(false);
  });

  it("returns false when detached but within TTL", () => {
    const detached = 1_000_000;
    const now = detached + TTL_MS - 1;
    expect(shouldEvictDeviceBuffer(detached, now, TTL_MS)).toBe(false);
  });

  it("returns true when detached exactly at TTL boundary", () => {
    const detached = 1_000_000;
    const now = detached + TTL_MS;
    expect(shouldEvictDeviceBuffer(detached, now, TTL_MS)).toBe(true);
  });

  it("returns true when detached past TTL", () => {
    const detached = 1_000_000;
    const now = detached + TTL_MS + 1000;
    expect(shouldEvictDeviceBuffer(detached, now, TTL_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DeviceBufferStore
// ---------------------------------------------------------------------------

describe("DeviceBufferStore", () => {
  it("acquire returns resumed:false and epoch 1 on first call", () => {
    const store = makeStore();
    const result = store.acquire("dev-A");
    expect(result.resumed).toBe(false);
    expect(result.epoch).toBe(1);
    expect(result.buffer).toBeDefined();
    expect(result.clock).toBeDefined();
  });

  it("acquire resumes the same buffer when resumeEpoch matches", () => {
    const store = makeStore();
    const first = store.acquire("dev-A");
    store.release("dev-A");
    const second = store.acquire("dev-A", { resumeEpoch: first.epoch });
    expect(second.resumed).toBe(true);
    expect(second.epoch).toBe(first.epoch);
    expect(second.buffer).toBe(first.buffer);
  });

  it("acquire creates a fresh buffer when resumeEpoch does not match", () => {
    const store = makeStore();
    const first = store.acquire("dev-A");
    store.release("dev-A");
    const second = store.acquire("dev-A", { resumeEpoch: 999 });
    expect(second.resumed).toBe(false);
    expect(second.epoch).toBe(2);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("acquire with no resumeEpoch on an EXISTING entry returns a fresh buffer + new epoch", () => {
    const store = makeStore();
    const first = store.acquire("dev-A");
    store.release("dev-A");
    // No resumeEpoch — undefined never matches a real epoch number.
    const second = store.acquire("dev-A");
    expect(second.resumed).toBe(false);
    expect(second.epoch).toBe(2);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("acquire creates independent buffers per deviceId", () => {
    const store = makeStore();
    const a = store.acquire("dev-A");
    const b = store.acquire("dev-B");
    expect(a.buffer).not.toBe(b.buffer);
    expect(a.epoch).toBe(1);
    expect(b.epoch).toBe(2);
  });

  it("bufferFor and epochFor return the active entry values", () => {
    const store = makeStore();
    const { buffer, epoch } = store.acquire("dev-A");
    expect(store.bufferFor("dev-A")).toBe(buffer);
    expect(store.epochFor("dev-A")).toBe(epoch);
  });

  it("bufferFor and epochFor return undefined for unknown deviceId", () => {
    const store = makeStore();
    expect(store.bufferFor("unknown")).toBeUndefined();
    expect(store.epochFor("unknown")).toBeUndefined();
  });

  it("hasRetainedBuffers is false before any acquire, true after", () => {
    const store = makeStore();
    expect(store.hasRetainedBuffers()).toBe(false);
    store.acquire("dev-A");
    expect(store.hasRetainedBuffers()).toBe(true);
  });

  it("hasRetainedBuffers returns true for a currently-attached (not yet released) device", () => {
    const store = makeStore();
    store.acquire("dev-A"); // acquired but NOT released — still attached
    // An attached device blocks eviction just like a detached-but-within-TTL one.
    expect(store.hasRetainedBuffers()).toBe(true);
  });

  it("sweepExpired evicts detached entries past TTL", () => {
    const store = makeStore();
    store.acquire("dev-A");
    store.release("dev-A");
    store.acquire("dev-B");
    store.release("dev-B");

    const FAR_FUTURE = Date.now() + TTL_MS + 1000;
    const evicted = store.sweepExpired(FAR_FUTURE, TTL_MS);
    expect(evicted).toBe(2);
    expect(store.hasRetainedBuffers()).toBe(false);
  });

  it("sweepExpired does not evict a still-attached entry (detachedAtMs is null)", () => {
    const store = makeStore();
    store.acquire("dev-A");
    // Never released — detachedAtMs remains null.
    const evicted = store.sweepExpired(Number.MAX_SAFE_INTEGER, 0);
    expect(evicted).toBe(0);
    expect(store.hasRetainedBuffers()).toBe(true);
  });

  it("release warns on unknown deviceId (no throw)", () => {
    const store = makeStore();
    // Should not throw — just a warn log.
    expect(() => store.release("ghost")).not.toThrow();
  });

  it("reuses the same activity clock across a resumed acquire", () => {
    const store = new DeviceBufferStore(1024);
    const first = store.acquire("dev-1");
    const resumed = store.acquire("dev-1", { resumeEpoch: first.epoch });
    expect(resumed.resumed).toBe(true);
    expect(resumed.clock).toBe(first.clock);
  });
});
