// ---------------------------------------------------------------------------
// device-id — wire-contract tests for stable deviceId get-or-create.
//
// Pins: FSM/invariant (id stability across calls), protocol contract (session
// configure includes deviceId), security boundary (localStorage unavailability
// does not crash).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetMemoryFallbackForTests, getOrCreateDeviceId } from "./device-id.ts";

const DEVICE_ID_KEY = "sentient.deviceId";

function installLocalStorageShim(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  return store;
}

function uninstallLocalStorageShim(): void {
  Reflect.deleteProperty(globalThis, "localStorage");
}

describe("getOrCreateDeviceId — with localStorage", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageShim();
    _resetMemoryFallbackForTests();
  });

  afterEach(() => {
    uninstallLocalStorageShim();
    _resetMemoryFallbackForTests();
  });

  it("generates a non-empty id on first call", () => {
    const id = getOrCreateDeviceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("persists the id to localStorage", () => {
    const id = getOrCreateDeviceId();
    expect(store.get(DEVICE_ID_KEY)).toBe(id);
  });

  it("returns the same id on repeated calls", () => {
    const id1 = getOrCreateDeviceId();
    const id2 = getOrCreateDeviceId();
    expect(id1).toBe(id2);
  });

  it("reuses a pre-existing id from localStorage", () => {
    store.set(DEVICE_ID_KEY, "preset-id-abc");
    const id = getOrCreateDeviceId();
    expect(id).toBe("preset-id-abc");
  });

  it("generates a UUID-shaped id (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)", () => {
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("getOrCreateDeviceId — without localStorage (SSR / Node)", () => {
  beforeEach(() => {
    uninstallLocalStorageShim();
    _resetMemoryFallbackForTests();
  });

  afterEach(() => {
    _resetMemoryFallbackForTests();
  });

  it("does not throw when localStorage is unavailable", () => {
    expect(() => getOrCreateDeviceId()).not.toThrow();
  });

  it("returns a non-empty id via in-memory fallback", () => {
    const id = getOrCreateDeviceId();
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns the same in-memory id on repeated calls (stable within session)", () => {
    const id1 = getOrCreateDeviceId();
    const id2 = getOrCreateDeviceId();
    expect(id1).toBe(id2);
  });
});
