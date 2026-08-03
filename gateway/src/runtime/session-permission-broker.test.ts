// A permission prompt belongs to the SESSION, not to a socket (session-model
// spec §2.4). The security boundary being pinned here:
//
//   - one session-global `requestId`, fanned to EVERY attached window, so any
//     window's answer names the same prompt;
//   - the FIRST answer settles it and a second is REFUSED, never re-decided —
//     a deny a later allow can overturn is a defect, not a race;
//   - fail closed both ways: the deadline denies, and a prompt no window can
//     see is denied AT ONCE rather than parked for a dialog nobody will open;
//   - the answering `attachmentId` is in the log, because with N windows "who
//     approved this" must be answerable — and the argument VALUES never are.
//
// Zero-cost: a fan-out double (one frame written to every attached window, as
// fan-out-emitter.ts's `broadcast` does it), no sockets, no I/O.

import { beforeAll, describe, expect, it } from "bun:test";
import { createGatewayLogger } from "../logging/logger.js";
import { TIMEOUT_MESSAGE } from "./permission-prompt.js";
import { createSessionPermissionBroker } from "./session-permission-broker.js";
import type { PermissionEmitter, SessionPermissionBroker } from "./session-permission-broker.js";
import type { PermissionRequest } from "./turn-emitter.js";

const SESSION_ID = "s_00000000000000000000000000000001";
const USER_ID = "u_deadbeef";
const A_ID = "at_window-a";
const B_ID = "at_window-b";
/** Short enough to await, long enough not to race a synchronous answer. */
const SHORT_DEADLINE_MS = 20;
/** An argument VALUE that must never reach a log line — only its key may. */
const SECRET_ARG = "unlock the front door for the courier";

interface FakeWindow {
  readonly attachmentId: string;
  readonly received: Array<Record<string, unknown>>;
}

interface FakeSession {
  readonly emitter: PermissionEmitter;
  readonly attachedWindows: () => number;
  window(attachmentId: string): FakeWindow;
  detach(attachmentId: string): void;
  detachAll(): void;
}

/** The session's delivery set as the real fan-out presents it: one frame
 *  written to every window attached AT EMIT TIME. */
function fakeSession(attachmentIds: readonly string[] = [A_ID, B_ID]): FakeSession {
  const windows: FakeWindow[] = attachmentIds.map((attachmentId) => ({ attachmentId, received: [] }));
  const broadcast = (frame: Record<string, unknown>): void => {
    for (const window of windows) window.received.push(frame);
  };
  return {
    emitter: {
      permissionRequest: (req) => broadcast({ type: "permission.request", ...req }),
      permissionResolved: (res) => broadcast({ type: "permission.resolved", ...res }),
    },
    attachedWindows: () => windows.length,
    window(attachmentId) {
      const found = windows.find((w) => w.attachmentId === attachmentId);
      if (found === undefined) throw new Error(`no window ${attachmentId} attached`);
      return found;
    },
    detach(attachmentId) {
      const index = windows.findIndex((w) => w.attachmentId === attachmentId);
      if (index >= 0) windows.splice(index, 1);
    },
    detachAll() {
      windows.length = 0;
    },
  };
}

function makeBroker(session: FakeSession): SessionPermissionBroker {
  return createSessionPermissionBroker({
    emitter: session.emitter,
    sessionId: SESSION_ID,
    userId: USER_ID,
    attachedWindows: session.attachedWindows,
  });
}

function permissionRequest(expiresInMs = 60_000): PermissionRequest {
  return {
    requestId: "req_1",
    toolCallId: "call-1",
    toolName: "ha_call_service",
    args: { service: SECRET_ARG },
    description: "Calling a Home Assistant service changes device state",
    expiresAtMs: Date.now() + expiresInMs,
  };
}

/** Every log line the gateway logger has emitted since this file loaded. The
 *  attribution contract (spec §7.3) is a LOG contract — the wire frame carries
 *  no attachmentId — so it can only be pinned here. */
const logLines: string[] = [];

beforeAll(async () => {
  await createGatewayLogger({ logLevel: "debug", testSink: (line) => logLines.push(line) });
});

function linesSince(mark: number, event: string): string[] {
  return logLines.slice(mark).filter((line) => line.includes(event));
}

describe("SessionPermissionBroker — the prompt belongs to the session", () => {
  it("INVARIANT: a prompt raised for one attachment can be answered by another", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest();

    const pending = broker.request(req, new AbortController().signal);

    expect(session.window(A_ID).received).toContainEqual(
      expect.objectContaining({ type: "permission.request", requestId: req.requestId }),
    );
    expect(session.window(B_ID).received).toContainEqual(
      expect.objectContaining({ type: "permission.request", requestId: req.requestId }),
    );
    expect(broker.resolve(req.requestId, { allow: true }, B_ID)).toBe(true);
    await expect(pending).resolves.toEqual({ allow: true });
  });

  it("SECURITY: a second answer to a settled prompt is refused and does not change the outcome", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest();

    const pending = broker.request(req, new AbortController().signal);

    expect(broker.resolve(req.requestId, { allow: false }, A_ID)).toBe(true);
    // The answered prompt LEFT the map — that is the property the refusal
    // below rests on, not a second flag that could drift from it.
    expect(broker.pendingCount).toBe(0);
    expect(broker.resolve(req.requestId, { allow: true }, B_ID)).toBe(false);
    await expect(pending).resolves.toEqual({ allow: false });
    // ONE closing frame, and it says denied — a second would re-open a
    // dismissed dialog on every window.
    expect(session.window(B_ID).received.filter((f) => f.type === "permission.resolved")).toEqual([
      { type: "permission.resolved", requestId: req.requestId, outcome: "denied" },
    ]);
  });

  it("INVARIANT: a prompt outlives the attachment that first displayed it", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest();

    const pending = broker.request(req, new AbortController().signal);
    session.detach(A_ID);

    expect(broker.resolve(req.requestId, { allow: true }, B_ID)).toBe(true);
    await expect(pending).resolves.toEqual({ allow: true });
  });

  it("INVARIANT: the deadline still runs after every window has left", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest(SHORT_DEADLINE_MS);

    const pending = broker.request(req, new AbortController().signal);
    session.detachAll();

    await expect(pending).resolves.toEqual({ allow: false, unavailable: TIMEOUT_MESSAGE });
    expect(broker.pendingCount).toBe(0);
  });

  it("SECURITY: a prompt with no attachments is denied at once, not queued", async () => {
    const session = fakeSession([]);
    const broker = makeBroker(session);

    await expect(broker.request(permissionRequest(), new AbortController().signal)).resolves.toEqual(
      expect.objectContaining({ allow: false }),
    );
    // Nothing parked, and nothing to park it for.
    expect(broker.pendingCount).toBe(0);
  });

  it("SECURITY: the deadline denies rather than approving", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest(SHORT_DEADLINE_MS);

    await expect(broker.request(req, new AbortController().signal)).resolves.toEqual({
      allow: false,
      unavailable: TIMEOUT_MESSAGE,
    });
    expect(session.window(A_ID).received).toContainEqual({
      type: "permission.resolved",
      requestId: req.requestId,
      outcome: "timeout",
    });
  });

  it("SECURITY: a prompt raised on an already-aborted turn is denied without opening a dialog", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const controller = new AbortController();
    controller.abort();

    await expect(broker.request(permissionRequest(), controller.signal)).resolves.toEqual(
      expect.objectContaining({ allow: false }),
    );
    expect(session.window(A_ID).received).toEqual([]);
    expect(broker.pendingCount).toBe(0);
  });

  it("refuses an answer naming a requestId no prompt is open under", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest();
    const pending = broker.request(req, new AbortController().signal);

    expect(broker.resolve("req_never-issued", { allow: true }, A_ID)).toBe(false);
    expect(broker.pendingCount).toBe(1);

    broker.denyAll("test teardown");
    await pending;
  });

  it("denyAll settles every outstanding prompt instead of leaking a parked turn", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const first = broker.request(permissionRequest(), new AbortController().signal);
    const second = broker.request({ ...permissionRequest(), requestId: "req_2" }, new AbortController().signal);
    expect(broker.pendingCount).toBe(2);

    broker.denyAll("the session was released");

    await expect(first).resolves.toEqual({ allow: false, unavailable: "the session was released" });
    await expect(second).resolves.toEqual({ allow: false, unavailable: "the session was released" });
    expect(broker.pendingCount).toBe(0);
  });

  it("INVARIANT: a resolution is attributable to the attachment that answered", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest();
    const pending = broker.request(req, new AbortController().signal);
    const mark = logLines.length;

    broker.resolve(req.requestId, { allow: true }, B_ID);
    await pending;

    const settled = linesSince(mark, "session-permission.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toContain(`attachmentId="${B_ID}"`);
  });

  it("SECURITY: logs the mediated argument KEYS and never their values", async () => {
    const session = fakeSession();
    const broker = makeBroker(session);
    const req = permissionRequest();
    const mark = logLines.length;

    const pending = broker.request(req, new AbortController().signal);
    broker.resolve(req.requestId, { allow: false }, A_ID);
    await pending;

    const emitted = logLines.slice(mark);
    expect(emitted.some((line) => line.includes("argKeys"))).toBe(true);
    expect(emitted.filter((line) => line.includes(SECRET_ARG))).toEqual([]);
  });
});
