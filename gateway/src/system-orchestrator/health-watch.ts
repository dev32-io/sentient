// Post-boot health watchdog for managed addons — the half of "restart on
// crash" that `apply()` cannot provide.
//
// WHY THIS EXISTS: `pollHealthy` only ever runs INSIDE the orchestrator's apply
// path, and apply() is triggered at boot, from the admin endpoint, and from the
// wizard. None of those fire when a service dies at 3am, so before this module a
// crashed addon stayed dead until an operator noticed. The migration E2E killed
// an addon and watched 65 s with zero recovery.
//
// IT IS A WATCHDOG, NOT A RESTART LOOP. Three properties keep it from becoming
// one:
//   1. A HEALTHY service is never re-applied. Only a failed probe acts.
//   2. Repeated failure BACKS OFF exponentially and then GIVES UP loudly. A
//      service that cannot start (bad config, missing interpreter, port taken)
//      must not be recreated every tick forever — that turns one broken addon
//      into sustained load and drowns the log. After giving up we keep PROBING
//      (cheap) so a service fixed out-of-band re-arms the watchdog by itself.
//   3. It never overlaps an in-flight apply(). A watchdog re-apply racing an
//      operator apply on the same service is two recreates of one container.
//
// Ticks are self-rescheduling (setTimeout, not setInterval) so a tick that runs
// longer than the interval can never overlap the next one.
import { getLog } from "../logging/logger.js";
import type { ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "health-watch"]);

/** Fallbacks for the two back-off knobs. The real values are operator-tunable
 *  in `config.yaml#system_orchestrator` and the gateway always passes both
 *  explicitly; these exist only so the watchdog is constructible standalone. */
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_FACTOR = 2;

export interface HealthWatchDeps {
  /** How often each watched service is re-probed, in ms. */
  intervalMs: number;
  /** Services to watch. Re-read every tick so a registry rebuild (new secret,
   *  edited config) is picked up without restarting the watchdog. */
  listServices: () => readonly ServiceName[];
  /** SINGLE-SHOT liveness probe — true = healthy. Deliberately not
   *  `pollHealthy`: that polls until the service's startup `timeout_ms`, which
   *  on a dead service would stall every tick for minutes. */
  probe: (name: ServiceName) => Promise<boolean>;
  /** Re-apply exactly one service (recreate + health-gate). */
  reapply: (name: ServiceName) => Promise<void>;
  /** True while an operator/wizard-initiated apply is running. The whole tick
   *  is skipped rather than racing it. */
  isApplyInFlight?: () => boolean;
  /** Consecutive failed recovery attempts before giving up on a service. */
  maxAttempts?: number;
  /** Multiplier widening the wait after each failed attempt. */
  backoffFactor?: number;
  /** Services that must never be abandoned. Giving up is right for a capability
   *  addon — a broken one recreated every tick is sustained load for no gain —
   *  but the public entrance has no operator watching it and no other path back:
   *  once given up on it stays dead until someone restarts the gateway by hand.
   *  Docker Desktop starting AFTER the LaunchDaemon (docs/native-todo.md) puts
   *  the proxy inside that window on a routine reboot. */
  neverGiveUp?: (name: ServiceName) => boolean;
}

export interface HealthWatch {
  /** Idempotent — a second call while running is a no-op. */
  start(): void;
  /** Ends the loop. No probe or re-apply happens after this returns. */
  stop(): void;
}

interface WatchState {
  /** Consecutive re-apply attempts since the service was last seen healthy. */
  attempts: number;
  /** Epoch ms before which no further re-apply is attempted (back-off). */
  nextAttemptAt: number;
  /** True once `maxAttempts` was exhausted — probing continues, re-applying stops. */
  gaveUp: boolean;
  /** True once the "would have given up" boundary was logged for THIS failure
   *  cycle on a `neverGiveUp` service. Without this latch, every tick spent
   *  waiting out a long back-off between attempts would re-log the crossing —
   *  the exact log-noise failure mode give-up exists to prevent. Reset to
   *  false alongside `attempts` on recovery, so the next failure cycle logs
   *  its own crossing again. */
  exemptLogged: boolean;
}

const FRESH_STATE: WatchState = { attempts: 0, nextAttemptAt: 0, gaveUp: false, exemptLogged: false };

export function createHealthWatch(deps: HealthWatchDeps): HealthWatch {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffFactor = deps.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const neverGiveUp = deps.neverGiveUp ?? (() => false);
  const states = new Map<ServiceName, WatchState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function schedule(): void {
    if (!running) return;
    timer = setTimeout(() => {
      void tick();
    }, deps.intervalMs);
    // A watchdog must never be the reason the process stays alive.
    timer.unref();
  }

  async function tick(): Promise<void> {
    if (!running) return;
    if (deps.isApplyInFlight?.() === true) {
      log.debug("tick.skipped", { reason: "apply-in-flight" });
      schedule();
      return;
    }
    for (const name of deps.listServices()) {
      // stop() may land mid-tick; honour it between services rather than
      // finishing a sweep into a torn-down driver.
      if (!running) return;
      await inspect(name);
    }
    schedule();
  }

  async function inspect(name: ServiceName): Promise<void> {
    const state = states.get(name) ?? FRESH_STATE;
    const healthy = await probeSafely(name);
    if (healthy) {
      markHealthy(name, state);
      return;
    }
    if (!running) return;
    await handleUnhealthy(name, state);
  }

  async function probeSafely(name: ServiceName): Promise<boolean> {
    try {
      return await deps.probe(name);
    } catch (err: unknown) {
      log.debug("probe.error", {
        service: name,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  function markHealthy(name: ServiceName, state: WatchState): void {
    if (state.attempts === 0 && !state.gaveUp) return; // steady state — nothing to log
    log.info("service.recovered", {
      service: name,
      reason: state.gaveUp ? "healthy-after-give-up" : "healthy-after-reapply",
      attempts: state.attempts,
    });
    states.set(name, { ...FRESH_STATE });
  }

  async function handleUnhealthy(name: ServiceName, state: WatchState): Promise<void> {
    if (state.gaveUp) {
      log.debug("reapply.suppressed", { service: name, reason: "gave-up", attempts: state.attempts });
      return;
    }
    if (state.attempts >= maxAttempts && !neverGiveUp(name)) {
      log.error("reapply.gave-up", {
        service: name,
        reason: "max-attempts-exhausted",
        attempts: state.attempts,
        maxAttempts,
      });
      states.set(name, { ...state, gaveUp: true });
      return;
    }
    // Reaching here with attempts >= maxAttempts means neverGiveUp(name) is
    // true — an ordinary service already returned above. Log the crossing
    // exactly once per failure cycle so production has something distinctive
    // to grep for when the front door is retrying past its nominal budget.
    const current = state.attempts >= maxAttempts && !state.exemptLogged ? logExemptionOnce(name, state) : state;
    const now = Date.now();
    if (now < current.nextAttemptAt) {
      log.debug("reapply.deferred", {
        service: name,
        reason: "backoff",
        waitMs: current.nextAttemptAt - now,
      });
      return;
    }
    await reapplyOnce(name, current, now);
  }

  function logExemptionOnce(name: ServiceName, state: WatchState): WatchState {
    log.warn("reapply.exempted", { service: name, reason: "infra-never-give-up", attempts: state.attempts });
    const next = { ...state, exemptLogged: true };
    states.set(name, next);
    return next;
  }

  async function reapplyOnce(name: ServiceName, state: WatchState, now: number): Promise<void> {
    const attempt = state.attempts + 1;
    // Cap the exponent at maxAttempts so a never-give-up service settles into a
    // steady retry cadence instead of backing off toward never. Without the cap,
    // attempt 40 waits longer than the machine's uptime.
    const exponent = Math.min(attempt - 1, maxAttempts);
    const backoffMs = deps.intervalMs * backoffFactor ** exponent;
    log.warn("service.unhealthy", { service: name, reason: "health-probe-failed", attempt, maxAttempts });
    states.set(name, {
      attempts: attempt,
      nextAttemptAt: now + backoffMs,
      gaveUp: false,
      exemptLogged: state.exemptLogged,
    });
    try {
      await deps.reapply(name);
      // "dispatched", NOT "succeeded". reapply resolves when the apply call
      // returns, and an apply whose recreate FAILED still returns normally.
      // Only the next tick's probe can declare recovery, so claiming success
      // here would read as a green line in a trail that is actually failing.
      log.info("reapply.dispatched", { service: name, attempt, nextRetryInMs: backoffMs });
    } catch (err: unknown) {
      log.warn("reapply.failed", {
        service: name,
        attempt,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    start(): void {
      if (running) {
        log.debug("start.ignored", { reason: "already-running" });
        return;
      }
      running = true;
      log.info("started", { intervalMs: deps.intervalMs, maxAttempts, backoffFactor });
      schedule();
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      log.info("stopped", { reason: "shutdown" });
    },
  };
}
