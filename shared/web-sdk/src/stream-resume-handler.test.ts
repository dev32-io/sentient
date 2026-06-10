// ---------------------------------------------------------------------------
// stream-resume-handler — outbound wire-contract test.
//
// Pins: gateway↔SDK outbound contract (stream.resume frame sent on RECONNECT
// with lastSeq > 0; NOT sent on first connect or when cursor is zero).
//
// Testing doctrine: wire/protocol contract at a process boundary.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResumeCursor } from "./resume-cursor.ts";
import { _resetResumeStateForTests } from "./sdk-reconnect.ts";
import { type StreamResumeHandlerDeps, handleStreamResumed, sendStreamResume } from "./stream-resume-handler.ts";

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
    deviceId: overrides.deviceId ?? "dev-test",
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
// sendStreamResume — outbound wire contract
// ---------------------------------------------------------------------------

describe("sendStreamResume — outbound wire contract", () => {
  it("sends stream.resume with epoch/lastSeq/deviceId on RECONNECT when lastSeq > 0", () => {
    const deps = makeDeps({ deviceId: "device-abc" });
    // Simulate cursor after having received seq=5 epoch=42 in a prior session.
    deps.cursor.tryApply(5, 42);

    sendStreamResume(deps);

    expect(deps.sentMessages).toHaveLength(1);
    expect(deps.sentMessages[0]).toEqual({
      type: "stream.resume",
      epoch: 42,
      lastSeq: 5,
      deviceId: "device-abc",
    });
  });

  it("does NOT send stream.resume on first connect (lastSeq === 0)", () => {
    const deps = makeDeps({ deviceId: "device-abc" });
    // Fresh cursor — no seq applied yet.

    sendStreamResume(deps);

    expect(deps.sentMessages).toHaveLength(0);
  });

  it("does NOT send stream.resume after cursor reset (recovered=false)", () => {
    const deps = makeDeps({ deviceId: "device-abc" });
    // Apply seq then reset (simulating a not-recovered resume).
    deps.cursor.tryApply(10, 1);
    deps.cursor.reset();

    sendStreamResume(deps);

    expect(deps.sentMessages).toHaveLength(0);
  });

  it("sends the correct lastSeq after cursor advances multiple times", () => {
    const deps = makeDeps({ deviceId: "dev-xyz" });
    deps.cursor.tryApply(3, 1);
    deps.cursor.tryApply(7, 1);
    deps.cursor.tryApply(12, 1);

    sendStreamResume(deps);

    expect(deps.sentMessages).toHaveLength(1);
    const frame = deps.sentMessages[0] as { type: string; lastSeq: number };
    expect(frame.lastSeq).toBe(12);
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
