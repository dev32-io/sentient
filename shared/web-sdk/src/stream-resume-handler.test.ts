// ---------------------------------------------------------------------------
// stream-resume-handler — configure-carried-resume + inbound contract test.
//
// Pins: gateway↔SDK outbound contract (the resume params folded into
// session.configure on RECONNECT with lastSeq > 0; omitted on first connect or
// when the cursor is zero).
//
// Testing doctrine: wire/protocol contract at a process boundary.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResumeCursor } from "./resume-cursor.ts";
import { _resetResumeStateForTests } from "./sdk-reconnect.ts";
import { type StreamResumeHandlerDeps, buildConfigureResume, handleStreamResumed } from "./stream-resume-handler.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<StreamResumeHandlerDeps> & { sentMessages?: unknown[] } = {},
): StreamResumeHandlerDeps & { sentMessages: unknown[] } {
  const sentMessages: unknown[] = overrides.sentMessages ?? [];
  const messageHandlers = new Map<string, Set<(msg: unknown) => void>>();
  const cursor = overrides.cursor ?? createResumeCursor();
  return {
    cursor,
    send: overrides.send ?? ((msg) => sentMessages.push(msg)),
    getMessageHandlers: overrides.getMessageHandlers ?? (() => messageHandlers),
    sentMessages,
  };
}

// Minimal sessionStorage shim (no browser in vitest/node environment).
function installSessionStorageShim(store: Map<string, string>): void {
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
  Reflect.deleteProperty(globalThis, "sessionStorage");
}

// ---------------------------------------------------------------------------
// buildConfigureResume — configure-carried resume params
// ---------------------------------------------------------------------------

describe("buildConfigureResume — configure-carried resume", () => {
  it("returns {epoch,lastSeq} on RECONNECT when lastSeq > 0", () => {
    const cursor = createResumeCursor();
    // Simulate cursor after having received seq=5 epoch=42 in a prior session.
    cursor.tryApply(5, 42);

    expect(buildConfigureResume(cursor)).toEqual({ epoch: 42, lastSeq: 5 });
  });

  it("returns undefined on first connect (lastSeq === 0)", () => {
    const cursor = createResumeCursor();
    // Fresh cursor — no seq applied yet.

    expect(buildConfigureResume(cursor)).toBeUndefined();
  });

  it("returns undefined after cursor reset (recovered=false)", () => {
    const cursor = createResumeCursor();
    // Apply seq then reset (simulating a not-recovered resume).
    cursor.tryApply(10, 1);
    cursor.reset();

    expect(buildConfigureResume(cursor)).toBeUndefined();
  });

  it("carries the latest lastSeq after the cursor advances multiple times", () => {
    const cursor = createResumeCursor();
    cursor.tryApply(3, 1);
    cursor.tryApply(7, 1);
    cursor.tryApply(12, 1);

    expect(buildConfigureResume(cursor)).toEqual({ epoch: 1, lastSeq: 12 });
  });
});

// ---------------------------------------------------------------------------
// handleStreamResumed — inbound reaction
// ---------------------------------------------------------------------------

describe("handleStreamResumed — recovered=true", () => {
  it("does not reset cursor or trigger refetch when recovered=true", () => {
    const deps = makeDeps();
    deps.cursor.tryApply(5, 1);
    const switchedCalls: unknown[] = [];
    const handlers = new Map<string, Set<(msg: unknown) => void>>();
    handlers.set("session.switched", new Set([(msg) => switchedCalls.push(msg)]));
    const depsWithHandlers = { ...deps, getMessageHandlers: () => handlers };

    handleStreamResumed(depsWithHandlers, true);

    // Cursor must be untouched.
    expect(deps.cursor.cursor.lastSeq).toBe(5);
    // No synthetic session.switched dispatched.
    expect(switchedCalls).toHaveLength(0);
  });
});

describe("handleStreamResumed — recovered=false", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    installSessionStorageShim(store);
    _resetResumeStateForTests();
  });

  afterEach(() => {
    uninstallSessionStorageShim();
    _resetResumeStateForTests();
  });

  it("resets cursor to {epoch:0, lastSeq:0} when recovered=false", () => {
    const deps = makeDeps();
    deps.cursor.tryApply(8, 3);
    expect(deps.cursor.cursor.lastSeq).toBe(8);

    handleStreamResumed(deps, false);

    expect(deps.cursor.cursor.lastSeq).toBe(0);
    expect(deps.cursor.cursor.epoch).toBe(0);
  });

  it("dispatches synthetic session.switched when a session id is available", () => {
    store.set("sentient.currentSessionId", "sess-test-123");
    const deps = makeDeps();
    deps.cursor.tryApply(3, 1);
    const switchedCalls: unknown[] = [];
    const handlers = new Map<string, Set<(msg: unknown) => void>>();
    handlers.set("session.switched", new Set([(msg) => switchedCalls.push(msg)]));
    const depsWithHandlers = { ...deps, getMessageHandlers: () => handlers };

    handleStreamResumed(depsWithHandlers, false);

    expect(switchedCalls).toHaveLength(1);
    expect(switchedCalls[0]).toEqual({ type: "session.switched", sessionId: "sess-test-123" });
  });

  it("does not dispatch session.switched when no session id is stored", () => {
    // sessionStorage is empty.
    const deps = makeDeps();
    deps.cursor.tryApply(3, 1);
    const switchedCalls: unknown[] = [];
    const handlers = new Map<string, Set<(msg: unknown) => void>>();
    handlers.set("session.switched", new Set([(msg) => switchedCalls.push(msg)]));
    const depsWithHandlers = { ...deps, getMessageHandlers: () => handlers };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    handleStreamResumed(depsWithHandlers, false);

    expect(switchedCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("does not dispatch session.switched when no handlers are registered", () => {
    store.set("sentient.currentSessionId", "sess-no-handlers");
    const deps = makeDeps();
    deps.cursor.tryApply(3, 1);
    // No handlers registered for session.switched.
    const handlers = new Map<string, Set<(msg: unknown) => void>>();
    const depsWithHandlers = { ...deps, getMessageHandlers: () => handlers };

    // Should not throw.
    expect(() => handleStreamResumed(depsWithHandlers, false)).not.toThrow();
  });
});
