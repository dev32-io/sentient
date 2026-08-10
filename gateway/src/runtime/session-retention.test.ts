// A session stays resident because WORK IS HAPPENING, not because a flag says
// so (session-model spec §5, plan task 8).
//
// THE DEFECT THESE CASES CLOSE IS LIVE, not hypothetical. `SessionRuntime`'s
// `dispose()` leaves registered background tasks running — NOTHING cancels one,
// not even interrupt (tools/delegate-task.ts) — but it CLOSES THE SQLITE
// HANDLE, so the completion of a task it left alive can never land. Which makes
// this predicate the ONLY thing standing between a delegated task and a lost
// result: with no cancel path anywhere, residency is the whole mechanism.
// Driven on the real stack before this module existed:
//
//   22:27:35 delegate-task.run.guard-decision  taskId=00394962…
//   22:27:39 session-registry.disposed         reason="the session's disposal
//                                              policy released it"
//   22:27:39 store.closed
//   22:28:24 hermes-runner.run.ok              outputLength=4319
//   22:28:24 WARN session-runtime.submit.disposed kind="background-completion"
//
// 4319 characters of delegated work, discarded, because a tab closed. Every
// INVARIANT below is a term of the predicate that makes that impossible.
//
// WHY DERIVED AND NOT A FLAG: a stored `workInFlight` boolean would be set and
// cleared at six sites and eventually leak one — holding a session resident for
// the life of the process, or dropping one mid-work. Nothing here stores
// whether work is happening; every evaluation re-reads it.

import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { SessionHandles } from "../session-handlers/session-registry.js";
import { createSessionRegistry } from "../session-handlers/session-registry.js";
import type { SessionData } from "../session-handlers/ws-helpers.js";
import { createSessionRetentionPolicy } from "./session-retention-policy.js";
import type { RetentionTimerMeta } from "./session-retention-policy.js";
import type { SessionLivenessInputs, SessionWorkSignals } from "./session-retention.js";
import { computeRetentionReasons, createBackgroundTaskWatchdog, isRetained } from "./session-retention.js";
import type { SessionRuntime } from "./session-runtime.js";

const RETENTION_MS = 900_000;
const RECHECK_MS = 30_000;
/** Longer than one Hermes one-shot's own deadline — see the config comment. */
const LOST_TASK_THRESHOLD_MS = 660_000;
/** High enough that the residency cap never fires in the cases that are not
 *  about it. The cap has its own harness below. */
const UNCAPPED = 1000;
const SOCKET = {} as ServerWebSocket<SessionData>;

/** No window, no turn, no tool, no task, no prompt. */
const idle: SessionLivenessInputs = {
  hasSubscribers: false,
  isTurnInFlight: false,
  hasPendingForegroundTool: false,
  hasUnfinishedBackgroundTask: false,
  hasOutstandingPrompt: false,
  hasAuxiliaryTaskInFlight: false,
};

/** Held by the one term that needs no timer: somebody is watching. */
const retained: SessionLivenessInputs = { ...idle, hasSubscribers: true };

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

function fakeClock(startMs = 1_000_000): FakeClock {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

interface ArmedTimer {
  readonly meta: RetentionTimerMeta;
  readonly fire: () => void;
  cancelled: boolean;
}

/**
 * The retention timer as an FSM, driven without wall-clock sleeps: every arm
 * is recorded with its kind and its generation stamp, and a test fires the one
 * it names. A real `setTimeout` would make "the timer fired while a connection
 * was attaching" untestable — that race is the point of these cases.
 */
interface PolicyHarness {
  /** Feed the policy one liveness reading for session [sessionId]. */
  evaluate(inputs: SessionLivenessInputs, sessionId?: string): void;
  /** Make the next `dispose()` throw, as a real teardown can. */
  breakDisposal(): void;
  /** How many DISPOSAL timers have been armed. */
  readonly timerStarts: number;
  /** How many RE-CHECK timers have been armed — the periodic re-derivation
   *  that a session held only by work depends on. */
  readonly recheckStarts: number;
  /** True once any armed timer has been cancelled. */
  readonly timerCancelled: boolean;
  /** The generation stamp of the disposal timer currently armed. */
  readonly pendingGeneration: number;
  /** Deliver a disposal callback that was armed under [generation]. */
  fireDisposal(generation: number): void;
  readonly disposed: boolean;
}

function policyHarness(): PolicyHarness {
  const armed: ArmedTimer[] = [];
  let disposed = false;
  let disposalThrows = false;
  const work: { current: SessionLivenessInputs } = { current: idle };
  const clock = fakeClock();

  const policy = createSessionRetentionPolicy({
    retentionMs: RETENTION_MS,
    recheckIntervalMs: RECHECK_MS,
    lostTaskThresholdMs: LOST_TASK_THRESHOLD_MS,
    maxIdleResidentSessions: UNCAPPED,
    now: clock.now,
    schedule: (fire, _delayMs, meta) => {
      const timer: ArmedTimer = { meta, fire, cancelled: false };
      armed.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
  });

  const disposalTimers = (): ArmedTimer[] => armed.filter((t) => t.meta.kind === "disposal");

  return {
    evaluate(inputs, sessionId = "s_1") {
      work.current = inputs;
      policy({
        sessionId,
        get subscriberCount() {
          return work.current.hasSubscribers ? 1 : 0;
        },
        get work() {
          return workSignalsOf(work.current, clock.now());
        },
        dispose() {
          disposed = true;
          if (disposalThrows) throw new Error("permissions.denyAll blew up during teardown");
        },
      });
    },
    breakDisposal() {
      disposalThrows = true;
    },
    get timerStarts() {
      return disposalTimers().length;
    },
    get recheckStarts() {
      return armed.filter((t) => t.meta.kind === "recheck").length;
    },
    get timerCancelled() {
      return armed.some((t) => t.cancelled);
    },
    get pendingGeneration() {
      const pending = disposalTimers().filter((t) => !t.cancelled);
      return pending[pending.length - 1]?.meta.generation ?? -1;
    },
    fireDisposal(generation) {
      const timer = disposalTimers().find((t) => t.meta.generation === generation);
      if (timer === undefined) throw new Error(`no disposal timer armed at generation ${generation}`);
      timer.fire();
    },
    get disposed() {
      return disposed;
    },
  };
}

/** The six booleans as the SESSION presents them — a background task is a
 *  timestamp on the wire into the predicate, not a boolean, because a task
 *  that stops reporting has to be time-boundable (see the watchdog case). */
function workSignalsOf(inputs: SessionLivenessInputs, nowMs: number): SessionWorkSignals {
  return {
    isTurnInFlight: inputs.isTurnInFlight,
    hasPendingForegroundTool: inputs.hasPendingForegroundTool,
    hasOutstandingPrompt: inputs.hasOutstandingPrompt,
    hasAuxiliaryTaskInFlight: inputs.hasAuxiliaryTaskInFlight,
    newestBackgroundTaskStartedAtMs: inputs.hasUnfinishedBackgroundTask ? nowMs : null,
  };
}

interface RegistryHarness {
  readonly registry: ReturnType<typeof createSessionRegistry>;
  build(): SessionHandles;
  /** Flip a work term on the live session, WITHOUT any attach or detach. */
  setBackgroundTaskRunning(running: boolean): void;
  readonly pendingGeneration: number;
  fireDisposal(generation: number): void;
  readonly disposed: boolean;
}

/** The real registry driven by the real policy — the only way to state the
 *  §5.1 race, which is about an attach landing between a timer firing and the
 *  handles being torn down. */
function registryHarness(): RegistryHarness {
  const armed: ArmedTimer[] = [];
  const clock = fakeClock();
  let disposed = false;
  let backgroundStartedAtMs: number | null = null;

  const policy = createSessionRetentionPolicy({
    retentionMs: RETENTION_MS,
    recheckIntervalMs: RECHECK_MS,
    lostTaskThresholdMs: LOST_TASK_THRESHOLD_MS,
    maxIdleResidentSessions: UNCAPPED,
    now: clock.now,
    schedule: (fire, _delayMs, meta) => {
      const timer: ArmedTimer = { meta, fire, cancelled: false };
      armed.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
  });

  const registry = createSessionRegistry(policy);
  const disposalTimers = (): ArmedTimer[] => armed.filter((t) => t.meta.kind === "disposal");

  return {
    registry,
    build: () =>
      ({
        runtime: {} as SessionRuntime,
        work: {
          isTurnInFlight: false,
          hasPendingForegroundTool: false,
          hasOutstandingPrompt: false,
          hasAuxiliaryTaskInFlight: false,
          get newestBackgroundTaskStartedAtMs() {
            return backgroundStartedAtMs;
          },
        },
        dispose: () => {
          disposed = true;
        },
      }) as unknown as SessionHandles,
    setBackgroundTaskRunning(running) {
      backgroundStartedAtMs = running ? clock.now() : null;
    },
    get pendingGeneration() {
      const pending = disposalTimers().filter((t) => !t.cancelled);
      return pending[pending.length - 1]?.meta.generation ?? -1;
    },
    fireDisposal(generation) {
      const timer = disposalTimers().find((t) => t.meta.generation === generation);
      if (timer === undefined) throw new Error(`no disposal timer armed at generation ${generation}`);
      timer.fire();
    },
    get disposed() {
      return disposed;
    },
  };
}

interface CappedHarness {
  readonly clock: FakeClock;
  /** Make [sessionId] resident with nothing holding it. */
  goIdle(sessionId: string): void;
  /** Make [sessionId] resident and held by a running background task. */
  goBusy(sessionId: string): void;
  /** Start work on an already-idle session WITHOUT re-evaluating it — the way
   *  a background task registers in production. */
  startWorkSilently(sessionId: string): void;
  /** Session ids torn down, in the order the cap released them. */
  readonly disposed: string[];
}

/** Several sessions against one policy, each with independent work — what the
 *  residency cap is about and what `policyHarness`'s single mutable reading
 *  cannot express. Timers are armed and never fired: the cap must act on its
 *  own, without waiting for any grace window to elapse. */
function cappedHarness(maxIdleResidentSessions: number): CappedHarness {
  const clock = fakeClock();
  const disposed: string[] = [];
  const busy = new Set<string>();

  const policy = createSessionRetentionPolicy({
    retentionMs: RETENTION_MS,
    recheckIntervalMs: RECHECK_MS,
    lostTaskThresholdMs: LOST_TASK_THRESHOLD_MS,
    maxIdleResidentSessions,
    now: clock.now,
    schedule: () => ({ cancel: () => {} }),
  });

  function evaluate(sessionId: string): void {
    policy({
      sessionId,
      subscriberCount: 0,
      get work() {
        return workSignalsOf({ ...idle, hasUnfinishedBackgroundTask: busy.has(sessionId) }, clock.now());
      },
      dispose() {
        disposed.push(sessionId);
      },
    });
  }

  return {
    clock,
    goIdle(sessionId) {
      evaluate(sessionId);
    },
    goBusy(sessionId) {
      busy.add(sessionId);
      evaluate(sessionId);
    },
    startWorkSilently(sessionId) {
      busy.add(sessionId);
    },
    disposed,
  };
}

// ---------------------------------------------------------------------------

describe("retention is derived from observable work", () => {
  it("INVARIANT: retention reports which term holds the session, not just that one does", () => {
    const reasons = computeRetentionReasons({ ...idle, hasUnfinishedBackgroundTask: true });

    expect(reasons).toEqual(["hasUnfinishedBackgroundTask"]);
    expect(isRetained({ ...idle, hasUnfinishedBackgroundTask: true })).toBe(true);
  });

  it("returns every holding term, so one term clearing cannot look like release", () => {
    const reasons = computeRetentionReasons({ ...idle, isTurnInFlight: true, hasOutstandingPrompt: true });

    expect(reasons).toEqual(["isTurnInFlight", "hasOutstandingPrompt"]);
  });
});

describe("the disposal timer", () => {
  it("INVARIANT: the disposal timer starts on the transition to not-retained, not on every check", () => {
    const policy = policyHarness();

    policy.evaluate(retained);
    policy.evaluate(retained);
    expect(policy.timerStarts).toBe(0);

    policy.evaluate(idle);
    expect(policy.timerStarts).toBe(1);
  });

  it("INVARIANT: a repeated not-retained check does not restart the grace period", () => {
    // The counter-case for the one above: re-arming on every check would push
    // disposal out indefinitely for a session that is polled — the grace window
    // would never actually elapse.
    const policy = policyHarness();

    policy.evaluate(idle);
    policy.evaluate(idle);
    policy.evaluate(idle);

    expect(policy.timerStarts).toBe(1);
  });

  it("INVARIANT: work resuming cancels a pending disposal rather than racing it", () => {
    const policy = policyHarness();

    policy.evaluate(idle);
    policy.evaluate({ ...idle, hasSubscribers: true });

    expect(policy.timerCancelled).toBe(true);
  });
});

describe("the disposal race (spec §5.1)", () => {
  it("INVARIANT: a timer that fired while a connection was attaching cannot dispose a live session", () => {
    const harness = registryHarness();
    const a = harness.registry.attach("s_1", "conn-a", SOCKET, harness.build);
    harness.registry.detach("s_1", a.attachmentId);
    const stamp = harness.pendingGeneration;

    harness.registry.attach("s_1", "conn-late", SOCKET, harness.build); // arrives after the timer fired
    harness.fireDisposal(stamp);

    expect(harness.disposed).toBe(false);
  });

  it("INVARIANT: disposal re-derives retention at fire time, not only its generation stamp", () => {
    // The counter-case that kills the tempting wrong fix. A generation stamp
    // alone is enough ONLY for work that moves through the registry: an attach
    // bumps the generation. Work starting is NOT a registry event — a
    // background task registered during the grace window cancels nothing and
    // moves no stamp, so the stamp still matches when the timer fires. Only a
    // fresh derivation inside the same synchronous step saves the session.
    const harness = registryHarness();
    const a = harness.registry.attach("s_1", "conn-a", SOCKET, harness.build);
    harness.registry.detach("s_1", a.attachmentId);
    const stamp = harness.pendingGeneration;

    harness.setBackgroundTaskRunning(true); // no attach, no detach, no reevaluate
    harness.fireDisposal(stamp);

    // `disposed === false` is what carries this: nothing cancelled the timer
    // and nothing moved the generation, so the stamp still matched when the
    // callback ran and only the fire-time re-derivation declined the teardown.
    expect(harness.disposed).toBe(false);
  });

  it("disposes once nothing holds the session at fire time", () => {
    const harness = registryHarness();
    const a = harness.registry.attach("s_1", "conn-a", SOCKET, harness.build);
    harness.registry.detach("s_1", a.attachmentId);

    harness.fireDisposal(harness.pendingGeneration);

    expect(harness.disposed).toBe(true);
  });
});

describe("a background task that stops reporting", () => {
  it("INVARIANT: a background task that stops reporting is marked lost and stops holding the session", () => {
    const clock = fakeClock();
    const watchdog = createBackgroundTaskWatchdog({
      sessionId: "s_1",
      thresholdMs: LOST_TASK_THRESHOLD_MS,
      now: clock.now,
    });
    const work = workSignalsOf({ ...idle, hasUnfinishedBackgroundTask: true }, clock.now());

    expect(computeRetentionReasons(watchdog.observe(work, false).inputs)).toEqual(["hasUnfinishedBackgroundTask"]);

    clock.advance(LOST_TASK_THRESHOLD_MS + 1);
    const observation = watchdog.observe(work, false);

    expect(computeRetentionReasons(observation.inputs)).toEqual([]);
    expect(observation.lostBackgroundTask).toEqual(
      expect.objectContaining({ reason: expect.stringContaining("lost") }),
    );
  });

  it("keeps holding the session while the newest task is still inside the threshold", () => {
    const clock = fakeClock();
    const watchdog = createBackgroundTaskWatchdog({
      sessionId: "s_1",
      thresholdMs: LOST_TASK_THRESHOLD_MS,
      now: clock.now,
    });
    const work = workSignalsOf({ ...idle, hasUnfinishedBackgroundTask: true }, clock.now());

    clock.advance(LOST_TASK_THRESHOLD_MS - 1);
    const observation = watchdog.observe(work, false);

    expect(observation.inputs.hasUnfinishedBackgroundTask).toBe(true);
    expect(observation.lostBackgroundTask).toBeNull();
  });
});

describe("the timer callback is detached from every caller", () => {
  it("INVARIANT: a teardown that throws is contained, not an uncaught exception", () => {
    // `input.dispose()` runs `permissions.denyAll()` -> `runtime.dispose()` ->
    // `voice.cancelAudio()` + `store.close()` -> `replayRegistry.release()`.
    // That chain used to run synchronously inside the WS close path, where a
    // throw failed ONE connection. It now runs from a bare timer, and an
    // uncaught exception there is a `launchd` KeepAlive restart — every other
    // user's live session dropped because one session's teardown threw.
    const policy = policyHarness();
    policy.evaluate(idle);
    policy.breakDisposal();

    expect(() => policy.fireDisposal(policy.pendingGeneration)).not.toThrow();
  });
});

describe("the idle-residency cap", () => {
  it("INVARIANT: the cap releases the session that has been idle longest", () => {
    // Derived retention removed the bound that used to hold implicitly: walking
    // the past-chats drawer builds a full session per chat visited, and each
    // one now lingers for the whole retention window.
    const harness = cappedHarness(2);

    harness.goIdle("s_1");
    harness.clock.advance(1000);
    harness.goIdle("s_2");
    harness.clock.advance(1000);
    harness.goIdle("s_3");

    expect(harness.disposed).toEqual(["s_1"]);
  });

  it("INVARIANT: a session held by work is not an eviction candidate at all", () => {
    // The candidate filter is what carries this one: a retained session is on a
    // re-check timer, not a disposal timer, so it is never in the pool the cap
    // draws from.
    const harness = cappedHarness(1);

    harness.goBusy("s_1"); // held by an unfinished background task
    harness.clock.advance(1000);
    harness.goIdle("s_2");
    harness.clock.advance(1000);
    harness.goIdle("s_3");

    expect(harness.disposed).toEqual(["s_2"]);
  });

  it("INVARIANT: eviction re-derives, so work acquired since going idle declines it", () => {
    // The §5.1 shape again, reached through the cap instead of the timer. A
    // session that went idle IS a candidate; work starting afterwards is not a
    // registry event, so nothing re-files it and it is still in the pool when
    // the cap fires. Only the re-derivation inside the ordinary disposal path
    // saves it — an eviction that just called `dispose()` would make the cap a
    // second way to orphan a delegated task.
    const harness = cappedHarness(1);

    harness.goIdle("s_1");
    harness.clock.advance(1000);
    harness.startWorkSilently("s_1"); // no evaluation — the cap must notice
    harness.goIdle("s_2");

    expect(harness.disposed).toEqual([]);
  });
});

describe("re-evaluating a session nobody is watching", () => {
  it("INVARIANT: a session held only by work is re-derived on a timer, since work completing is not a registry event", () => {
    // Without this, a task that finishes with no window attached leaves the
    // session resident until something else touches the registry — and the only
    // things that touch it are attach and detach, neither of which is going to
    // happen.
    const policy = policyHarness();

    policy.evaluate({ ...idle, hasUnfinishedBackgroundTask: true });

    expect(policy.timerStarts).toBe(0); // not disposal — work still holds it…
    expect(policy.recheckStarts).toBe(1); // …but it will be asked again
  });

  it("arms no timer at all while a window is attached", () => {
    // `hasSubscribers` cannot lapse without a detach, and a detach re-enters
    // the policy. A ticking timer for every watched session would be pure cost.
    const policy = policyHarness();

    policy.evaluate(retained);

    expect(policy.timerStarts).toBe(0);
    expect(policy.recheckStarts).toBe(0);
  });
});
