// Permission round-trip contract (spec §5.3/§7.1, Plan 3 Task 6). Pins the
// FSM every surface's dialog depends on AND the fail-closed security
// boundary: nothing but an explicit `approved: true` from THIS connection
// ever resolves to allow. Zero-cost — hand-rolled emitter double, no I/O.

import { describe, expect, it } from "bun:test";
import { ConfirmUnavailableError } from "../tools/tool-types.js";
import type { ToolInvocation } from "../tools/tool-types.js";
import type { PermissionEmitter, PermissionPrompt, PermissionResolution } from "./permission-broker.js";
import { createPermissionBroker } from "./permission-broker.js";

interface RecordingEmitter extends PermissionEmitter {
  requests: PermissionPrompt[];
  resolutions: PermissionResolution[];
}

function recordingEmitter(): RecordingEmitter {
  const requests: PermissionPrompt[] = [];
  const resolutions: PermissionResolution[] = [];
  return {
    requests,
    resolutions,
    permissionRequest: (req) => requests.push(req),
    permissionResolved: (res) => resolutions.push(res),
  };
}

function makeBroker(emitter: PermissionEmitter, timeoutMs = 60000) {
  return createPermissionBroker({ emitter, sessionId: "session-1", userId: "u_aaaaaaaa", timeoutMs });
}

function invocation(signal = new AbortController().signal): ToolInvocation {
  return {
    toolCallId: "call-1",
    name: "ha_call_service",
    args: { domain: "light", service: "turn_on" },
    signal,
    turnId: "turn-1",
  };
}

describe("PermissionBroker — the confirm round-trip", () => {
  it("emits one permission.request carrying the PDP reason as the description and a future expiry", () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter);
    const before = Date.now();

    // Never answered here — this case is about the OUTBOUND prompt only.
    // `denyAll()` below settles it (and clears its timer) so the case leaves
    // neither a live timeout nor an unhandled rejection behind.
    const pending = broker.request(invocation(), "Calling a Home Assistant service changes device state");
    pending.catch(() => {});

    expect(emitter.requests).toHaveLength(1);
    const req = emitter.requests[0];
    expect(req).toMatchObject({
      toolCallId: "call-1",
      toolName: "ha_call_service",
      args: { domain: "light", service: "turn_on" },
      description: "Calling a Home Assistant service changes device state",
    });
    expect(req?.requestId.length).toBeGreaterThan(0);
    expect(req?.expiresAtMs).toBeGreaterThan(before);
    expect(broker.pendingCount).toBe(1);

    broker.denyAll();
  });

  it("resolves true and emits permission.resolved allowed when the user approves", async () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter);
    const pending = broker.request(invocation(), "why");
    const requestId = emitter.requests[0]?.requestId ?? "";

    expect(broker.resolve(requestId, true)).toBe(true);

    await expect(pending).resolves.toBe(true);
    expect(emitter.resolutions).toEqual([{ requestId, outcome: "allowed" }]);
    expect(broker.pendingCount).toBe(0);
  });

  it("resolves false and emits permission.resolved denied when the user declines", async () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter);
    const pending = broker.request(invocation(), "why");
    const requestId = emitter.requests[0]?.requestId ?? "";

    broker.resolve(requestId, false);

    await expect(pending).resolves.toBe(false);
    expect(emitter.resolutions).toEqual([{ requestId, outcome: "denied" }]);
  });

  it("auto-denies on timeout — never an implicit approval — and tells the model why", async () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter, 20);
    const pending = broker.request(invocation(), "why");
    const requestId = emitter.requests[0]?.requestId ?? "";

    await expect(pending).rejects.toThrow(ConfirmUnavailableError);
    await expect(pending).rejects.toThrow("permission request timed out");
    expect(emitter.resolutions).toEqual([{ requestId, outcome: "timeout" }]);
    expect(broker.pendingCount).toBe(0);
  });

  it("ignores an unknown requestId — no throw, no frame, no settle", () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter);
    const pending = broker.request(invocation(), "why");
    pending.catch(() => {});

    expect(broker.resolve("not-a-real-request-id", true)).toBe(false);
    expect(emitter.resolutions).toEqual([]);
    expect(broker.pendingCount).toBe(1);

    broker.denyAll();
  });

  it("ignores a duplicate response — the first answer wins", async () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter);
    const pending = broker.request(invocation(), "why");
    const requestId = emitter.requests[0]?.requestId ?? "";

    expect(broker.resolve(requestId, false)).toBe(true);
    expect(broker.resolve(requestId, true)).toBe(false);

    await expect(pending).resolves.toBe(false);
    expect(emitter.resolutions).toEqual([{ requestId, outcome: "denied" }]);
  });

  it("ignores a response that lands after the timeout already fired", async () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter, 20);
    const pending = broker.request(invocation(), "why");
    const requestId = emitter.requests[0]?.requestId ?? "";

    await expect(pending).rejects.toThrow(ConfirmUnavailableError);
    expect(broker.resolve(requestId, true)).toBe(false);
    expect(emitter.resolutions).toEqual([{ requestId, outcome: "timeout" }]);
  });

  it("denyAll settles every outstanding request instead of leaking a pending promise", async () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter);
    const a = broker.request(invocation(), "why");
    const b = broker.request(invocation(), "why");
    expect(broker.pendingCount).toBe(2);

    broker.denyAll();

    await expect(a).rejects.toThrow(ConfirmUnavailableError);
    await expect(b).rejects.toThrow("client disconnected");
    expect(broker.pendingCount).toBe(0);
    // The socket is gone — emitting permission.resolved into it is pointless.
    expect(emitter.resolutions).toEqual([]);
  });

  it("settles as denied when the turn is aborted underneath an open prompt", async () => {
    const emitter = recordingEmitter();
    const broker = makeBroker(emitter);
    const controller = new AbortController();
    const pending = broker.request(invocation(controller.signal), "why");
    const requestId = emitter.requests[0]?.requestId ?? "";

    controller.abort();

    await expect(pending).rejects.toThrow(ConfirmUnavailableError);
    // "aborted" is not on the frozen wire — it maps to denied so the client
    // dismisses the dialog fail-closed.
    expect(emitter.resolutions).toEqual([{ requestId, outcome: "denied" }]);
    expect(broker.pendingCount).toBe(0);
  });
});
