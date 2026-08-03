// ---------------------------------------------------------------------------
// sdk-reconnect — the per-tab session pointer's deletion rule.
//
// The pointer is what a tab presents as `conversationId` on `session.configure`
// (the gateway↔SDK wire), and it is the ONLY way back into a conversation since
// the id stopped being derived server-side from `(userId, surfaceId)`. Deleting
// it wrongly loses the conversation, so the rule that deletes it is pinned here
// on its own: deletion is a failsafe on an EXPLICIT server refusal, and its
// condition is a conjunction — this tab presented an id AND the server refused
// it. The frame-level mapping (which gateway frame means which) is pinned in
// sentient-sdk.test.ts.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_SESSION_STORAGE_KEY,
  _resetSessionPointerForTests,
  clearRefusedSessionId,
  getCurrentSessionId,
  markSessionPresented,
  setCurrentSessionId,
} from "./sdk-reconnect.ts";

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

describe("session pointer — deletion is a failsafe on an explicit refusal", () => {
  beforeEach(() => {
    installSessionStorageShim();
    _resetSessionPointerForTests();
  });
  afterEach(() => {
    uninstallSessionStorageShim();
    _resetSessionPointerForTests();
  });

  it("drops the stored id when the id this tab presented is refused", () => {
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, "s_stale");
    markSessionPresented("s_stale");

    clearRefusedSessionId(null);

    expect(getCurrentSessionId()).toBeNull();
  });

  it("INVARIANT: a second refusal on the same answer cannot delete a pointer re-anchored since", () => {
    // The presented marker is spent by the first drop, so the draft key the
    // caller stores immediately afterwards is not eligible to be deleted by
    // anything else arriving on this connection.
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, "s_stale");
    markSessionPresented("s_stale");

    clearRefusedSessionId(null);
    setCurrentSessionId("d_fresh");
    clearRefusedSessionId(null);

    expect(getCurrentSessionId()).toBe("d_fresh");
  });

  it("INVARIANT: a tab that presented nothing deletes nothing on a refusal", () => {
    // A first-ever connect presents no id and is answered with `session.draft`
    // too. Reading that as a refusal would have it delete a pointer it never
    // had — which is why the condition is the conjunction and not the frame.
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, "s_fresh");
    markSessionPresented(null);

    expect(() => clearRefusedSessionId(null)).not.toThrow();
    expect(getCurrentSessionId()).toBe("s_fresh");
  });

  it("INVARIANT: an honoured id survives — nothing after the answer can refuse it", () => {
    // The defect this replaces: a ~200ms timer deleted an id that had just
    // resolved correctly, because it fired on SILENCE rather than on a refusal.
    markSessionPresented("s_live");

    setCurrentSessionId("s_live");
    clearRefusedSessionId(null);

    expect(getCurrentSessionId()).toBe("s_live");
  });

  it("treats an empty presented value as presenting nothing", () => {
    sessionStorage.setItem(CURRENT_SESSION_STORAGE_KEY, "s_fresh");
    markSessionPresented("");

    clearRefusedSessionId(null);

    expect(getCurrentSessionId()).toBe("s_fresh");
  });
});

describe("session pointer — non-browser / disabled storage", () => {
  beforeEach(() => {
    uninstallSessionStorageShim();
    _resetSessionPointerForTests();
  });
  afterEach(() => {
    _resetSessionPointerForTests();
  });

  it("reads null and writes without throwing when sessionStorage is undefined (SSR / Node)", () => {
    expect(getCurrentSessionId()).toBeNull();
    expect(() => setCurrentSessionId("s_1")).not.toThrow();
    markSessionPresented("s_1");
    expect(() => clearRefusedSessionId(null)).not.toThrow();
  });
});
