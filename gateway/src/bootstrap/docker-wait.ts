import Dockerode from "dockerode";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "bootstrap", "docker-wait"]);

/** Minimal slice of Dockerode needed for a ping — keeps the wait testable
 *  without constructing a real Dockerode instance. */
export interface DockerPinger {
  ping(): Promise<unknown>;
}

export interface WaitForDockerOptions {
  readonly docker: DockerPinger;
  /** Maximum total wait. 0 = skip the wait entirely (return immediately). */
  readonly timeoutMs: number;
  /** Interval between ping attempts. */
  readonly pollMs: number;
}

/**
 * Wait for the docker daemon to be reachable, bounded and non-fatal.
 *
 * Calls `docker.ping()` in a loop until it resolves (true) or the timeout
 * elapses (false, WARN). Never throws — a docker-wait failure is a degraded
 * boot, not a fatal one, because the health-watchdog retries the apply later.
 *
 * `timeoutMs: 0` skips the wait entirely (returns true immediately, no ping) —
 * for hosts where the daemon is always up or the wait is unwanted.
 *
 * The Dockerode instance is constructed throwaway (lazy connect) — this is
 * cheap and avoids coupling the wait to the orchestrator's own Dockerode.
 */
export async function waitForDocker(opts: WaitForDockerOptions): Promise<boolean> {
  if (opts.timeoutMs <= 0) {
    log.debug("docker-wait.skipped", { reason: "timeout_ms is 0" });
    return true;
  }

  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      await opts.docker.ping();
      log.info("docker-wait.ready", { attempts: attempt, elapsedMs: opts.timeoutMs - (deadline - Date.now()) });
      return true;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("docker-wait.ping-failed", { attempt, reason });
    }
    // Sleep for pollMs, but do not overshoot the deadline.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const sleepMs = Math.min(opts.pollMs, remaining);
    await sleep(sleepMs);
  }

  log.warn("docker-wait.timeout", { attempts: attempt, timeoutMs: opts.timeoutMs });
  return false;
}

/** Construct a throwaway Dockerode instance for the wait. Dockerode connects
 *  lazily — constructing it is cheap; the first ping() is what opens the socket. */
export function createDockerPinger(): DockerPinger {
  return new Dockerode() as unknown as DockerPinger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
