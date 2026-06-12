/**
 * Task 3.7 — Resumable-disconnect / full-teardown split.
 *
 * Pins the behaviour of cleanupSession({ full: false }) vs ({ full: true }):
 *
 *  A) Resumable disconnect (transport close + stream.resume + device buffer):
 *     - AttentionGate NOT disposed.
 *     - ACP unsub / wire-dispose NOT called.
 *     - Session NOT removed from router/manager/controls.
 *     - Device buffer RELEASED (TTL started), NOT disposed.
 *     - A frame journaled AFTER the close still lands in the buffer.
 *     - deferredTeardown is stashed in the buffer entry.
 *
 *  B) Full teardown (session.end or no stream.resume):
 *     - AttentionGate IS disposed.
 *     - ACP unsub / wire-dispose called.
 *     - Session IS removed from router/manager/controls.
 *     - Device buffer DISPOSED (entry removed, no TTL).
 *
 *  C) Retention sweep running deferred teardown exactly once (idempotency).
 *     - After the buffer entry TTL expires, sweep evicts and calls deferredTeardown.
 *     - Second sweep call: teardown fn is NOT called again (idempotent guard).
 *
 *  D) Reconnect cancels deferred teardown so it never fires.
 *
 *  E) Transport close WITHOUT stream.resume → full teardown (fallback).
 */

import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { DeviceBufferStore } from "../person-session/device-buffer-store.js";
import { PersonSession } from "../person-session/person-session.js";
import { cleanupSession } from "./ws-handlers.js";
import type { ClientData } from "./ws-helpers.js";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const REPLAY_MAX_BYTES = 64 * 1024;
const TTL_MS = 30_000;

function makePersonSession(): PersonSession {
  return new PersonSession({
    profile: "alice",
    hermesUrl: "http://hermes:8650",
    hermesApiKey: "test-key",
    userId: "alice",
    replayBufferMaxBytes: REPLAY_MAX_BYTES,
  });
}

function makeAttachment(id: string) {
  return { attachmentId: id, releaseSocket: vi.fn() };
}

function makeServices(): GatewayServices {
  return {
    sessionControls: { unregister: vi.fn(), register: vi.fn() },
    sessionRouter: { release: vi.fn(), bind: vi.fn(), get: vi.fn(), updateConversationId: vi.fn() },
    sessionManager: { removeSession: vi.fn(), createSession: vi.fn(), unbindUser: vi.fn(), bindUser: vi.fn() },
  } as unknown as GatewayServices;
}

/**
 * Build a minimal ServerWebSocket<ClientData> stub with the fields cleanupSession
 * reads. The real Bun ws object is not available in unit tests, so we use a
 * plain object cast.
 */
function makeWs(overrides: Partial<ClientData>): ServerWebSocket<ClientData> {
  const data: ClientData = {
    sessionId: "sess-001",
    connectedAt: Date.now(),
    authState: "authed",
    userId: "alice",
    authTimeout: null,
    shortTermContext: null,
    taskManager: null,
    attentionGate: null,
    adapters: [],
    conversationHistory: null,
    conversationFeedUnsub: null,
    taskLifecycleUnsub: null,
    audioAdapter: null,
    textAdapter: null,
    grantedCapabilities: new Set(),
    clientType: "webui",
    isStreaming: false,
    preferenceManager: null,
    preferenceUnsub: null,
    preferenceAudioUnsub: null,
    bargeInController: null,
    interruptController: null,
    personSession: null,
    attachment: null,
    resumeSessionId: null,
    sessionsHandlers: null,
    lastSessionNewAtMs: null,
    snapshotUnsub: null,
    acpWireDispose: null,
    acpSdkFrameUnsub: null,
    activityClock: null,
    ...overrides,
  };
  return { data, send: vi.fn(), close: vi.fn() } as unknown as ServerWebSocket<ClientData>;
}

/** Stub AttentionGateHandle-like object. */
function makeGate() {
  return { dispose: vi.fn(), clearPendingConversationSalience: vi.fn(), clearConversationSalience: vi.fn() };
}

// ---------------------------------------------------------------------------
// A) Resumable disconnect path
// ---------------------------------------------------------------------------

describe("cleanupSession — resumable disconnect (full=false + stream.resume)", () => {
  it("does NOT dispose the attention gate", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const gate = makeGate();
    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      attentionGate: gate as never,
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    expect(gate.dispose).not.toHaveBeenCalled();
  });

  it("does NOT call acpSdkFrameUnsub or acpWireDispose", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const acpSdkFrameUnsub = vi.fn();
    const acpWireDispose = vi.fn();

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      acpSdkFrameUnsub,
      acpWireDispose,
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    expect(acpSdkFrameUnsub).not.toHaveBeenCalled();
    expect(acpWireDispose).not.toHaveBeenCalled();
  });

  it("does NOT unregister the session from sessionControls/Router/Manager", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    expect(services.sessionControls.unregister).not.toHaveBeenCalled();
    expect(services.sessionRouter.release).not.toHaveBeenCalled();
    expect(services.sessionManager.removeSession).not.toHaveBeenCalled();
  });

  it("releases the device buffer (TTL started) but does NOT remove it", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    // Buffer still exists (not disposed)
    expect(session.bufferFor("sess-001")).toBeDefined();
  });

  it("frames journaled AFTER the close land in the buffer", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    const { buffer } = session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    const seqBefore = buffer.newestSeq;
    // Simulate the cycle-output pipeline writing to the buffer directly
    // (via the FrameSequencer, which holds a ref to the buffer object).
    buffer.append(new TextEncoder().encode(JSON.stringify({ type: "assistant.message", text: "hello" })), "text");

    expect(buffer.newestSeq).toBeGreaterThan(seqBefore);
  });

  it("stashes a deferredTeardown on the device buffer entry via DeviceBufferStore", () => {
    // Test the DeviceBufferStore directly to confirm the deferred teardown
    // is stashed on release.
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    store.acquire("dev-A");
    const teardown = vi.fn();
    store.release("dev-A", teardown);

    // Sweep past TTL — should call teardown.
    const future = Date.now() + TTL_MS + 1000;
    store.sweepIdle(future, TTL_MS);

    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// B) Full teardown path
// ---------------------------------------------------------------------------

describe("cleanupSession — full teardown (full=true)", () => {
  it("disposes the attention gate", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const gate = makeGate();
    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      attentionGate: gate as never,
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: true });

    expect(gate.dispose).toHaveBeenCalledTimes(1);
  });

  it("calls acpSdkFrameUnsub and acpWireDispose", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const acpSdkFrameUnsub = vi.fn();
    const acpWireDispose = vi.fn();

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      acpSdkFrameUnsub,
      acpWireDispose,
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: true });

    expect(acpSdkFrameUnsub).toHaveBeenCalledTimes(1);
    expect(acpWireDispose).toHaveBeenCalledTimes(1);
  });

  it("removes the session from sessionControls/Router/Manager", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: true });

    expect(services.sessionControls.unregister).toHaveBeenCalledWith("sess-001");
    expect(services.sessionRouter.release).toHaveBeenCalledWith("sess-001");
    expect(services.sessionManager.removeSession).toHaveBeenCalledWith("sess-001");
  });

  it("disposes the device buffer entry immediately (bufferFor returns undefined after full teardown)", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: true });

    expect(session.bufferFor("sess-001")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C) Retention sweep runs deferred teardown exactly once (idempotency)
// ---------------------------------------------------------------------------

describe("DeviceBufferStore.sweepIdle — deferred teardown lifecycle", () => {
  it("runs deferredTeardown when the entry is evicted by sweep", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    store.acquire("dev-A");
    const teardown = vi.fn();
    store.release("dev-A", teardown);

    const future = Date.now() + TTL_MS + 1000;
    const evicted = store.sweepIdle(future, TTL_MS);

    expect(evicted).toBe(1);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("does NOT run deferredTeardown a second time on subsequent sweeps", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    store.acquire("dev-A");
    const teardown = vi.fn();
    store.release("dev-A", teardown);

    const future = Date.now() + TTL_MS + 1000;
    // First sweep evicts and calls teardown.
    store.sweepIdle(future, TTL_MS);
    // Second sweep — entry is already gone, teardown must not be called again.
    store.sweepIdle(future + 1000, TTL_MS);

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("idempotency guard prevents double-run even when teardown is called manually then by sweep", () => {
    // The deferredTeardown closure itself has an idempotency guard (tornDown flag).
    // This test verifies the guard using the raw DeviceBufferStore.release + sweepIdle.
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    store.acquire("dev-A");

    let callCount = 0;
    let tornDown = false;
    const teardown = (): void => {
      if (tornDown) return;
      tornDown = true;
      callCount += 1;
    };

    store.release("dev-A", teardown);
    // Manually call it once (simulates any direct early-teardown path).
    teardown();
    // Sweep now tries to call it again.
    const future = Date.now() + TTL_MS + 1000;
    store.sweepIdle(future, TTL_MS);

    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D) Reconnect cancels deferred teardown
// ---------------------------------------------------------------------------

describe("DeviceBufferStore.acquire — hands deferredTeardown back on resume (Task 3.8)", () => {
  it("returns the stashed teardown and detaches it from the entry so the sweep cannot re-run it", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const first = store.acquire("dev-A");
    const teardown = vi.fn();
    store.release("dev-A", teardown);

    // Device reconnects with correct epoch — acquire HANDS the teardown back
    // (Task 3.8 handover) instead of silently dropping it. The caller runs it.
    const resumed = store.acquire("dev-A", { resumeEpoch: first.epoch });
    expect(resumed.priorDeferredTeardown).toBe(teardown);

    // Sweep — teardown must NOT be called by the sweep (acquire detached it).
    const future = Date.now() + TTL_MS + 1000;
    store.release("dev-A"); // release again so sweep is eligible
    store.sweepIdle(future, TTL_MS);

    expect(teardown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// E) Transport close WITHOUT stream.resume → full teardown (fallback)
// ---------------------------------------------------------------------------

describe("cleanupSession — transport close without stream.resume falls through to full teardown", () => {
  it("disposes the gate when stream.resume is absent from capabilities", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const gate = makeGate();
    const ws = makeWs({
      sessionId: "sess-001",
      // No stream.resume in capabilities
      grantedCapabilities: new Set(["text.input", "audio.input"]),
      attentionGate: gate as never,
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    expect(gate.dispose).toHaveBeenCalledTimes(1);
  });

  it("removes session when stream.resume absent (full:false falls through)", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(),
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    expect(services.sessionManager.removeSession).toHaveBeenCalledWith("sess-001");
  });

  it("disposes buffer entry immediately (no TTL) when fallback path runs", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(),
      personSession: session,
      attachment: attachment as never,
    });
    const services = makeServices();

    cleanupSession(ws, services, { full: false });

    expect(session.bufferFor("sess-001")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F) End-to-end deferred lifecycle — real closure via teardownPipelineResources
// ---------------------------------------------------------------------------

describe("cleanupSession — deferred closure fires teardownPipelineResources on sweep", () => {
  it("service teardown calls fire exactly once when sweep evicts the buffer entry", () => {
    // Set up a real PersonSession + real DeviceBufferStore (no hand-rolled mock).
    // This pins that the actual deferredTeardown closure — produced by
    // runResumableDisconnect — calls the shared teardownPipelineResources helper,
    // which in turn invokes the three service registration teardown calls.
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const services = makeServices();

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      personSession: session,
      attachment: attachment as never,
    });

    // Trigger resumable disconnect — stashes the deferred closure in the buffer entry.
    cleanupSession(ws, services, { full: false });

    // Verify the three service teardowns have NOT fired yet.
    expect(services.sessionControls.unregister).not.toHaveBeenCalled();
    expect(services.sessionRouter.release).not.toHaveBeenCalled();
    expect(services.sessionManager.removeSession).not.toHaveBeenCalled();

    // Advance time past TTL and sweep — the closure fires via sweepIdle.
    const future = Date.now() + TTL_MS + 1000;
    session.sweepIdle(future, TTL_MS);

    // The three service teardown calls must have fired exactly once.
    expect(services.sessionControls.unregister).toHaveBeenCalledTimes(1);
    expect(services.sessionControls.unregister).toHaveBeenCalledWith("sess-001");
    expect(services.sessionRouter.release).toHaveBeenCalledTimes(1);
    expect(services.sessionRouter.release).toHaveBeenCalledWith("sess-001");
    expect(services.sessionManager.removeSession).toHaveBeenCalledTimes(1);
    expect(services.sessionManager.removeSession).toHaveBeenCalledWith("sess-001");
  });

  it("teardown fires exactly once even when sweep is called twice (idempotency)", () => {
    const session = makePersonSession();
    const attachment = makeAttachment("sess-001");
    session.acquireDeviceBuffer("sess-001");
    session.attach(attachment);

    const services = makeServices();

    const ws = makeWs({
      sessionId: "sess-001",
      grantedCapabilities: new Set(["stream.resume"]),
      personSession: session,
      attachment: attachment as never,
    });

    cleanupSession(ws, services, { full: false });

    const future = Date.now() + TTL_MS + 1000;
    // First sweep evicts the entry and fires the closure.
    session.sweepIdle(future, TTL_MS);
    // Second sweep — entry is gone, closure must not run again.
    session.sweepIdle(future + 1000, TTL_MS);

    expect(services.sessionControls.unregister).toHaveBeenCalledTimes(1);
    expect(services.sessionRouter.release).toHaveBeenCalledTimes(1);
    expect(services.sessionManager.removeSession).toHaveBeenCalledTimes(1);
  });
});
