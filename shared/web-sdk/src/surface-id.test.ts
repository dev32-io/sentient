// ---------------------------------------------------------------------------
// surface-id — wire-contract tests for per-tab surfaceId get-or-create.
//
// Pins: FSM/invariant (id stability across calls within a tab), protocol
// contract (session configure includes surfaceId), security boundary
// (sessionStorage unavailability does not crash).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSurfaceMemoryFallbackForTests, getOrCreateSurfaceId } from "./surface-id.ts";

const SURFACE_ID_KEY = "sentient.surfaceId";

function installSessionStorageShim(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
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

function uninstallSessionStorageShim(): void {
  Reflect.deleteProperty(globalThis, "sessionStorage");
}

describe("getOrCreateSurfaceId — with sessionStorage", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installSessionStorageShim();
    _resetSurfaceMemoryFallbackForTests();
  });

  afterEach(() => {
    uninstallSessionStorageShim();
    _resetSurfaceMemoryFallbackForTests();
  });

  it("generates a non-empty id on first call", () => {
    const id = getOrCreateSurfaceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("persists the id to sessionStorage under sentient.surfaceId", () => {
    const id = getOrCreateSurfaceId();
    expect(store.get(SURFACE_ID_KEY)).toBe(id);
  });

  it("returns the same id on repeated calls", () => {
    const id1 = getOrCreateSurfaceId();
    const id2 = getOrCreateSurfaceId();
    expect(id1).toBe(id2);
  });

  it("reuses a pre-existing id from sessionStorage", () => {
    store.set(SURFACE_ID_KEY, "preset-surface-abc");
    const id = getOrCreateSurfaceId();
    expect(id).toBe("preset-surface-abc");
  });

  it("generates a UUID-shaped id", () => {
    expect(getOrCreateSurfaceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("getOrCreateSurfaceId — without sessionStorage (SSR / Node)", () => {
  beforeEach(() => {
    uninstallSessionStorageShim();
    _resetSurfaceMemoryFallbackForTests();
  });

  afterEach(() => {
    _resetSurfaceMemoryFallbackForTests();
  });

  it("does not throw when sessionStorage is unavailable", () => {
    expect(() => getOrCreateSurfaceId()).not.toThrow();
  });

  it("returns a non-empty id via in-memory fallback", () => {
    expect(getOrCreateSurfaceId().length).toBeGreaterThan(0);
  });

  it("returns the same in-memory id on repeated calls", () => {
    expect(getOrCreateSurfaceId()).toBe(getOrCreateSurfaceId());
  });
});
