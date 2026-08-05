// The structural cutover's own contract (session-model plan task 5): exactly
// ONE `SessionRuntime` per `sessionId`, and N attachments to it.
//
// Every case here is an INVARIANT the old single-owner registry inverted. It
// evicted: a second connection claiming a conversation tore the first one down
// (`previous.evict()` → deny open prompts + `runtime.dispose()`, aborting the
// in-flight turn). Under this module a second connection JOINS, which is what
// makes multi-window delivery, session-scoped permissions and derived
// retention expressible at all.

import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { SessionWorkSignals } from "../runtime/session-retention.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { type SessionHandles, createSessionRegistry } from "./session-registry.js";
import type { SessionData } from "./ws-helpers.js";

/** A session that is doing nothing — every retention term false. These cases
 *  are about routing and residency counting, not about work; the derived
 *  retention predicate is pinned in runtime/session-retention.test.ts. */
const IDLE_WORK: SessionWorkSignals = {
  isTurnInFlight: false,
  hasPendingForegroundTool: false,
  hasOutstandingPrompt: false,
  hasAuxiliaryTaskInFlight: false,
  newestBackgroundTaskStartedAtMs: null,
};

/** The socket an attachment delivers to. Nothing here writes to it — these
 *  cases are about residency, not delivery (see fan-out-emitter.test.ts). */
const SOCKET = {} as ServerWebSocket<SessionData>;

interface HandlesSpy {
  build: () => SessionHandles;
  buildCallCount: () => number;
  disposed: () => boolean;
  runtime: SessionRuntime;
}

/** A build callback that counts its calls and records disposal — the two
 *  things every case below asserts on. The runtime itself is never driven. */
function handlesSpy(): HandlesSpy {
  const runtime = { dispose: () => {} } as unknown as SessionRuntime;
  let buildCalls = 0;
  let disposed = false;
  return {
    runtime,
    buildCallCount: () => buildCalls,
    disposed: () => disposed,
    build: () => {
      buildCalls += 1;
      return {
        runtime,
        permissions: { denyAll: () => {} },
        work: IDLE_WORK,
        dispose: () => {
          disposed = true;
        },
      } as unknown as SessionHandles;
    },
  };
}

describe("SessionRegistry — one runtime per session, N attachments", () => {
  it("INVARIANT: a second connection to one session shares the runtime, never forks or evicts it", () => {
    const registry = createSessionRegistry();
    const spy = handlesSpy();

    const a = registry.attach("s_1", "conn-a", SOCKET, spy.build);
    const b = registry.attach("s_1", "conn-b", SOCKET, spy.build);

    expect(spy.buildCallCount()).toBe(1);
    expect(registry.subscribers("s_1")).toHaveLength(2);
    expect(spy.disposed()).toBe(false); // A was NOT torn down
    expect(a.attachmentId).not.toBe(b.attachmentId);
  });

  it("INVARIANT: the runtime is disposed when the last attachment leaves", () => {
    const registry = createSessionRegistry();
    const spy = handlesSpy();

    const a = registry.attach("s_1", "conn-a", SOCKET, spy.build);
    const b = registry.attach("s_1", "conn-b", SOCKET, spy.build);

    registry.detach("s_1", a.attachmentId);
    expect(spy.disposed()).toBe(false);

    registry.detach("s_1", b.attachmentId);
    expect(spy.disposed()).toBe(true);
  });

  it("INVARIANT: a superseded connection's late close does not detach the live one", () => {
    const registry = createSessionRegistry();
    const spy = handlesSpy();

    const a = registry.attach("s_1", "conn-a", SOCKET, spy.build);
    registry.detach("s_1", a.attachmentId);
    registry.detach("s_1", a.attachmentId); // duplicate close event
    const b = registry.attach("s_1", "conn-b", SOCKET, spy.build);
    registry.detach("s_1", a.attachmentId); // stale

    expect(registry.subscribers("s_1")).toContainEqual(expect.objectContaining({ attachmentId: b.attachmentId }));
  });

  it("INVARIANT: distinct sessions get distinct runtimes", () => {
    const registry = createSessionRegistry();

    registry.attach("s_1", "conn-a", SOCKET, handlesSpy().build);
    registry.attach("s_2", "conn-b", SOCKET, handlesSpy().build);

    expect(registry.runtimeFor("s_1")).not.toBe(registry.runtimeFor("s_2"));
  });

  it("INVARIANT: a build failure leaves no half-attached session behind", () => {
    // `bindSessionRuntime`'s one swallowed failure (no active LLM key for this
    // user) reaches the registry as a throwing `build`. A session entry left
    // behind here would make the NEXT attach skip construction and hand out a
    // runtime that was never built.
    const registry = createSessionRegistry();

    expect(() =>
      registry.attach("s_1", "conn-a", SOCKET, () => {
        throw new Error("no active LLM key for this user");
      }),
    ).toThrow();

    expect(registry.size).toBe(0);
    expect(registry.runtimeFor("s_1")).toBeNull();
    expect(registry.subscribers("s_1")).toHaveLength(0);
  });

  it("INVARIANT: the disposal policy is a substitutable hook, not a fixed rule", () => {
    // The retention predicate (task 8) is SUBSTITUTED into this hook rather
    // than written into this module, and that substitutability is the property
    // pinned here — a policy that declines keeps the handles resident with zero
    // subscribers, which is what "a background task still running" looks like
    // to the registry.
    const registry = createSessionRegistry(() => {
      /* retention says: keep it, work is still in flight */
    });
    const spy = handlesSpy();

    const a = registry.attach("s_1", "conn-a", SOCKET, spy.build);
    registry.detach("s_1", a.attachmentId);

    expect(spy.disposed()).toBe(false);
    expect(registry.runtimeFor("s_1")).toBe(spy.runtime);
  });
});
