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
  /** Every reason this runtime was told its authority was revoked. */
  revocations: () => readonly string[];
  /** How many times this session's still-draining speech was cut. */
  speechCuts: () => number;
}

/** A build callback that counts its calls and records disposal — the two
 *  things every case below asserts on. The runtime itself is never driven.
 *
 *  [userId] is the only index `orphanSessionsForUser` has, so it is real even
 *  though nothing else here reads it. [work] lets a case make the session look
 *  like one held by a running background task, which is the state the orphaning
 *  cases are about. */
function handlesSpy(userId = "u_aaaaaaaa", work: SessionWorkSignals = IDLE_WORK): HandlesSpy {
  const revocations: string[] = [];
  let speechCuts = 0;
  const runtime = {
    userId,
    dispose: () => {},
    revokeAuthority: (reason: string) => {
      revocations.push(reason);
    },
    cutUnheardSpeech: () => {
      speechCuts += 1;
    },
  } as unknown as SessionRuntime;
  let buildCalls = 0;
  let disposed = false;
  return {
    runtime,
    buildCallCount: () => buildCalls,
    disposed: () => disposed,
    revocations: () => revocations,
    speechCuts: () => speechCuts,
    build: () => {
      buildCalls += 1;
      return {
        runtime,
        permissions: { denyAll: () => {} },
        work,
        dispose: () => {
          disposed = true;
        },
      } as unknown as SessionHandles;
    },
  };
}

/** A session that looks like one holding a still-running background task —
 *  the ONLY state that keeps a session resident with no window, and therefore
 *  the state every orphaning case below is about. */
const WORK_IN_FLIGHT: SessionWorkSignals = { ...IDLE_WORK, newestBackgroundTaskStartedAtMs: 1 };

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

// ---------------------------------------------------------------------------
// Orphaning — taking a revoked account's sessions out of the attach index.
//
// THE DEFECT THIS CLOSES IS USER-VISIBLE AND SILENT. `attach` returns an
// EXISTING resident and never calls `build`, and a session outlives its windows
// by `session.retention_ms` (15 min) while a background task is unfinished. So
// marking the runtime revoked and stopping there produced: parent demotes child
// → child is kicked → child signs in with a fresh principal → re-opens the same
// conversation → passes `refuseStaleAuthority`, because the record now matches
// → and lands back on the REVOKED runtime, which commits every message and
// answers none of them. A new conversation worked fine, which is exactly what
// makes it read as "the assistant is broken" rather than as a permission
// change.
//
// The fix is that the id must be free again, so the next attach BUILDS — with a
// capability minted from the record as it now stands. That the fresh runtime
// then actually runs a turn is pinned one layer down, in
// runtime/session-runtime.test.ts ("runs turns normally until it is revoked"):
// these cases pin that the attach reaches a fresh, unrevoked runtime at all,
// which is the half that was missing.
// ---------------------------------------------------------------------------

describe("SessionRegistry — orphaning a revoked account's sessions", () => {
  it("SECURITY: the next attach on the same id BUILDS a fresh runtime", () => {
    const registry = createSessionRegistry(() => {});
    const before = handlesSpy("u_child", WORK_IN_FLIGHT);
    const after = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, before.build);
    registry.orphanSessionsForUser("u_child");
    registry.attach("s_1", "conn-b", SOCKET, after.build);

    expect(after.buildCallCount()).toBe(1);
    expect(registry.runtimeFor("s_1")).toBe(after.runtime);
    expect(registry.runtimeFor("s_1")).not.toBe(before.runtime);
  });

  // The runtime the re-attach lands on must be one the revocation never
  // touched — a fresh build that inherited the revoked flag would be the same
  // dead chat with more steps.
  it("SECURITY: the rebuilt runtime carries no revocation", () => {
    const registry = createSessionRegistry(() => {});
    const before = handlesSpy("u_child", WORK_IN_FLIGHT);
    const after = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, before.build);
    for (const runtime of registry.orphanSessionsForUser("u_child")) runtime.revokeAuthority("role-changed");
    registry.attach("s_1", "conn-b", SOCKET, after.build);

    // POSITIVE FIRST. `after.revocations()` is empty whenever `after.build` was
    // never called, so on its own it passes for the very defect this pins — a
    // re-attach that handed back the OLD runtime. Asserting the registry serves
    // `after.runtime` is what makes the emptiness below mean something.
    expect(registry.runtimeFor("s_1")).toBe(after.runtime);
    expect(before.revocations()).toEqual(["role-changed"]);
    expect(after.revocations()).toEqual([]);
  });

  // NOT disposed: the orphan is the only thing that can still receive the
  // background task's completion, and disposing it closes the store handle that
  // result has to land through. Orphaning is not a teardown.
  it("keeps the orphan alive rather than disposing it", () => {
    const registry = createSessionRegistry(() => {});
    const spy = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, spy.build);
    const orphaned = registry.orphanSessionsForUser("u_child");

    expect(orphaned).toEqual([spy.runtime]);
    expect(spy.disposed()).toBe(false);
  });

  // Unreachable by every read seam, not just `attach` — `runtimeFor` and
  // `handlesFor` are how `ws-session-configure` and the command mediator find a
  // session, and either one handing back the orphan reopens the defect.
  it("makes the orphan unreachable by session id", () => {
    const registry = createSessionRegistry(() => {});
    const spy = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, spy.build);
    registry.orphanSessionsForUser("u_child");

    expect(registry.runtimeFor("s_1")).toBeNull();
    expect(registry.handlesFor("s_1")).toBeNull();
    expect(registry.subscribers("s_1")).toHaveLength(0);
  });

  // The orphan's windows are dead sockets by now (the revoker closed them), and
  // they MUST be dropped: `detach` finds a resident by SESSION ID, which the
  // orphan no longer has, so their close handlers would remove nothing,
  // `hasSubscribers` would hold forever, and the orphan would never be disposed.
  it("drops the orphan's windows, so its disposal is still reachable", () => {
    let residentCount = 0;
    const registry = createSessionRegistry((input) => {
      residentCount = input.subscriberCount;
    });
    const spy = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, spy.build);
    registry.attach("s_1", "conn-b", SOCKET, spy.build);
    registry.orphanSessionsForUser("u_child");

    // The evaluation the orphaning itself triggers sees no windows left.
    expect(residentCount).toBe(0);
  });

  // The revoker closes the sockets, but their close handlers — which is where
  // `cleanupSession` normally cuts the drain — run a tick later, by which time
  // this session has no id to be found under and that call is a no-op. Cutting
  // here is the last chance: without it a member demoted mid-reply keeps pulling
  // frames from local-tts and writing them at closed sockets until disposal,
  // minutes later, occupying the single-threaded on-host TTS for nobody.
  it("cuts the orphan's still-draining speech, which no close handler can still reach", () => {
    const registry = createSessionRegistry(() => {});
    const spy = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, spy.build);
    expect(spy.speechCuts()).toBe(0);

    registry.orphanSessionsForUser("u_child");

    expect(spy.speechCuts()).toBe(1);
  });

  // A session that was ALREADY windowless (retained by a background task, its
  // last window long gone) had its drain cut when that window left. Cutting
  // again would be a second gesture on a session nothing is draining for.
  it("does not cut speech for a session that had no window left", () => {
    const registry = createSessionRegistry(() => {});
    const spy = handlesSpy("u_child", WORK_IN_FLIGHT);

    const a = registry.attach("s_1", "conn-a", SOCKET, spy.build);
    registry.detach("s_1", a.attachmentId);
    registry.orphanSessionsForUser("u_child");

    expect(spy.speechCuts()).toBe(0);
  });

  // THE POLICY'S ENTRY FOR THE OLD ID MUST BE ABLE TO EXPIRE. For the ordinary
  // revocation — a session that HAD a window — the policy cleared that entry's
  // timer when the window attached, and it deletes its own tracking only from
  // the disposal path. Orphaning without re-evaluating the old id leaves it
  // timer-less and un-deletable, holding this whole handles graph for the life
  // of the process. Asserted through the policy's own view: it must be told
  // about the old id again, with no windows left, so it can arm one.
  it("re-evaluates the OLD id with no windows, so its retention entry can expire", () => {
    const seen: { sessionId: string; subscriberCount: number }[] = [];
    const registry = createSessionRegistry((input) => {
      seen.push({ sessionId: input.sessionId, subscriberCount: input.subscriberCount });
    });
    const spy = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, spy.build);
    seen.length = 0;
    registry.orphanSessionsForUser("u_child");

    const oldId = seen.filter((e) => e.sessionId === "s_1");
    expect(oldId).toHaveLength(1);
    expect(oldId[0]?.subscriberCount).toBe(0);
    // ...and the orphan's own entry, under a key no attach can reach.
    const orphan = seen.filter((e) => e.sessionId !== "s_1");
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.sessionId).toContain("#orphaned-");
  });

  // ONE ACCOUNT, TWO CONVERSATIONS — the everyday shape (a chat on the phone, a
  // chat on the laptop) and the one the cross-account cases below cannot reach.
  // Each needs its own orphan key, or the second would overwrite the first in
  // the resident map and silently drop a runtime still waiting on a task.
  it("orphans every one of an account's sessions, each under its own key", () => {
    const seen: string[] = [];
    const registry = createSessionRegistry((input) => {
      seen.push(input.sessionId);
    });
    const first = handlesSpy("u_child", WORK_IN_FLIGHT);
    const second = handlesSpy("u_child", WORK_IN_FLIGHT);

    registry.attach("s_1", "conn-a", SOCKET, first.build);
    registry.attach("s_2", "conn-b", SOCKET, second.build);
    const orphaned = registry.orphanSessionsForUser("u_child");

    expect(orphaned).toEqual([first.runtime, second.runtime]);
    expect(registry.runtimeFor("s_1")).toBeNull();
    expect(registry.runtimeFor("s_2")).toBeNull();
    // Both still resident, under two DISTINCT keys — a shared key would have
    // evicted the first from the map with nothing left to dispose it.
    expect(first.disposed()).toBe(false);
    expect(second.disposed()).toBe(false);
    const keys = new Set(seen.filter((id) => id.includes("#orphaned-")));
    expect(keys.size).toBe(2);
    expect(registry.size).toBe(2);
  });

  it("leaves another account's sessions attachable", () => {
    const registry = createSessionRegistry(() => {});
    const child = handlesSpy("u_child", WORK_IN_FLIGHT);
    const parent = handlesSpy("u_parent", WORK_IN_FLIGHT);

    registry.attach("s_child", "conn-a", SOCKET, child.build);
    registry.attach("s_parent", "conn-b", SOCKET, parent.build);
    const orphaned = registry.orphanSessionsForUser("u_child");

    expect(orphaned).toEqual([child.runtime]);
    expect(registry.runtimeFor("s_parent")).toBe(parent.runtime);
    expect(registry.runtimeFor("s_child")).toBeNull();
  });

  it("is a no-op for an account with nothing resident", () => {
    const registry = createSessionRegistry(() => {});
    const parent = handlesSpy("u_parent", WORK_IN_FLIGHT);

    registry.attach("s_parent", "conn-a", SOCKET, parent.build);

    expect(registry.orphanSessionsForUser("u_child")).toEqual([]);
    expect(registry.runtimeFor("s_parent")).toBe(parent.runtime);
  });

  // The orphan is still governed by the disposal policy under its new key — it
  // is not leaked. Under the default policy (dispose as soon as nothing holds
  // it) an orphan with NO work in flight is torn down immediately, which is the
  // observable proof that the policy still reaches it.
  it("still disposes an orphan that nothing is holding", () => {
    const registry = createSessionRegistry();
    const spy = handlesSpy("u_child", IDLE_WORK);

    // A window attached, so `hasSubscribers` holds it — the shape a revocation
    // actually finds.
    registry.attach("s_1", "conn-a", SOCKET, spy.build);
    expect(spy.disposed()).toBe(false);

    registry.orphanSessionsForUser("u_child");

    // Orphaning dropped the window and re-evaluated UNDER THE NEW KEY. Without
    // that second evaluation the policy's entry for `s_1` would be claimed by
    // the next attach and nothing would ever release this one.
    expect(spy.disposed()).toBe(true);
  });
});
