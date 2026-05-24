// ---------------------------------------------------------------------------
// sdk-reconnect — wire-contract tests for the WS connect-URL builder and the
// per-tab `sentient.currentSessionId` pointer. The connect URL IS the wire
// (gateway reads `?session_id=` at WS upgrade), so this is the wire-protocol
// boundary worth pinning per .claude/rules/testing.md.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetResumeStateForTests,
  buildConnectUrl,
  clearStaleResumeId,
  hasPendingResume,
  setCurrentSessionId,
} from "./sdk-reconnect.ts";

const STORAGE_KEY = "sentient.currentSessionId";
const GATEWAY = "wss://example.test/api/v1/ws";

// jsdom-like minimal sessionStorage shim — vitest runs in node by default.
function installSessionStorageShim(): void {
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
}

function uninstallSessionStorageShim(): void {
  // Reflect.deleteProperty is the only way to make
  // `typeof sessionStorage === "undefined"` true again under
  // exactOptionalPropertyTypes — assigning `undefined` keeps the property
  // defined (just with value undefined), and `typeof` returns "undefined"
  // either way except when accessed via global lookup.
  Reflect.deleteProperty(globalThis, "sessionStorage");
}

describe("buildConnectUrl — sessionStorage anchor → ?session_id=", () => {
  beforeEach(() => {
    installSessionStorageShim();
    _resetResumeStateForTests();
  });
  afterEach(() => {
    uninstallSessionStorageShim();
    _resetResumeStateForTests();
  });

  it("appends session_id when sessionStorage has a value", () => {
    sessionStorage.setItem(STORAGE_KEY, "sess-abc");
    const url = buildConnectUrl(GATEWAY);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("session_id")).toBe("sess-abc");
    expect(hasPendingResume()).toBe(true);
  });

  it("omits session_id when sessionStorage is empty", () => {
    const url = buildConnectUrl(GATEWAY);
    const parsed = new URL(url);
    expect(parsed.searchParams.has("session_id")).toBe(false);
    expect(hasPendingResume()).toBe(false);
  });

  it("omits session_id when sessionStorage holds an empty string", () => {
    sessionStorage.setItem(STORAGE_KEY, "");
    const url = buildConnectUrl(GATEWAY);
    expect(new URL(url).searchParams.has("session_id")).toBe(false);
    expect(hasPendingResume()).toBe(false);
  });

  it("preserves existing query params on the gateway URL", () => {
    sessionStorage.setItem(STORAGE_KEY, "sess-xyz");
    const url = buildConnectUrl(`${GATEWAY}?token=abc`);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("token")).toBe("abc");
    expect(parsed.searchParams.get("session_id")).toBe("sess-xyz");
  });

  it("returns the input verbatim and clears pending state on a non-URL gateway string", () => {
    sessionStorage.setItem(STORAGE_KEY, "sess-abc");
    const url = buildConnectUrl("not-a-url");
    expect(url).toBe("not-a-url");
    expect(hasPendingResume()).toBe(false);
  });
});

describe("setCurrentSessionId / clearStaleResumeId — pointer transitions", () => {
  beforeEach(() => {
    installSessionStorageShim();
    _resetResumeStateForTests();
  });
  afterEach(() => {
    uninstallSessionStorageShim();
    _resetResumeStateForTests();
  });

  it("setCurrentSessionId writes sessionStorage and clears pendingResume", () => {
    sessionStorage.setItem(STORAGE_KEY, "old-id");
    buildConnectUrl(GATEWAY);
    expect(hasPendingResume()).toBe(true);

    setCurrentSessionId("new-id");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("new-id");
    expect(hasPendingResume()).toBe(false);
  });

  it("setCurrentSessionId is a no-op for an empty id", () => {
    sessionStorage.setItem(STORAGE_KEY, "old-id");
    setCurrentSessionId("");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("old-id");
  });

  it("clearStaleResumeId removes sessionStorage when a resume was pending", () => {
    sessionStorage.setItem(STORAGE_KEY, "stale-id");
    buildConnectUrl(GATEWAY);
    clearStaleResumeId();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(hasPendingResume()).toBe(false);
  });

  it("clearStaleResumeId is a no-op when no resume is pending", () => {
    sessionStorage.setItem(STORAGE_KEY, "fresh-id");
    // Skipping buildConnectUrl — pendingResume stays null.
    clearStaleResumeId();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("fresh-id");
  });
});

describe("buildConnectUrl — non-browser / disabled storage", () => {
  beforeEach(() => {
    uninstallSessionStorageShim();
    _resetResumeStateForTests();
  });
  afterEach(() => {
    _resetResumeStateForTests();
  });

  it("omits session_id when sessionStorage is undefined (SSR / Node)", () => {
    const url = buildConnectUrl(GATEWAY);
    expect(new URL(url).searchParams.has("session_id")).toBe(false);
    expect(hasPendingResume()).toBe(false);
  });
});
