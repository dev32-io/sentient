// Single-instance guard for the gateway process.
//
// WHY. There must be exactly ONE gateway per machine, in dev and in prod. It
// owns singletons that do not tolerate a second holder: the per-user unix
// sockets under ~/.sentient/run, the per-user SQLite session stores, the docker
// addon reconcile loop, and the native addon supervisor. Two instances fight
// over all four, and the symptoms are indirect — an addon recreated out from
// under the other's health watch, a store written by a process that thinks it
// is alone.
//
// The port bind is the real mutex for two instances on the SAME port: Bun.serve
// throws EADDRINUSE and the second process dies. But it dies with a raw stack
// trace that names neither the winner nor the fix, and it does not catch the
// case where someone points a second instance at a different port, which
// conflicts on everything EXCEPT the port.
//
// So this adds an explicit claim: a pid file that records who is running, on
// what port, since when. It is advisory — the bind remains authoritative — and
// its job is to make the failure legible and to cover the different-port case.
//
// STALE FILES MUST NOT WEDGE STARTUP. A crash or a SIGKILL leaves the file
// behind. A guard that refuses to start on a file's mere existence turns every
// hard kill into a manual cleanup step, so liveness is checked, not existence.

import { getLog } from "../logging/logger.ts";

const log = getLog(["bootstrap", "single-instance"]);

/** pid 0 and negative pids address process GROUPS, not processes — and
 *  `-0 === 0` in JS, so a sign-flipped 0 signals the caller's own group. A pid
 *  file holding either is corrupt, never a live instance. */
const MIN_PLAUSIBLE_PID = 2;

export interface InstanceClaim {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: number;
}

export interface SingleInstanceIo {
  readonly readClaim: (path: string) => string | null;
  readonly writeClaim: (path: string, body: string) => void;
  readonly removeClaim: (path: string) => void;
  /** True when a process with this pid exists. Implemented with signal 0. */
  readonly isAlive: (pid: number) => boolean;
  readonly now: () => number;
  readonly selfPid: number;
}

export type AcquireResult =
  | { readonly ok: true; readonly release: () => void; readonly tookOverStale: boolean }
  | { readonly ok: false; readonly heldBy: InstanceClaim };

function parseClaim(raw: string | null): InstanceClaim | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceClaim>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    if (parsed.pid < MIN_PLAUSIBLE_PID) return null;
    return {
      pid: parsed.pid,
      port: typeof parsed.port === "number" ? parsed.port : 0,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Claims this machine's single gateway slot.
 *
 * Returns `ok: false` with the live holder's details when another instance is
 * already running — the caller reports it and exits. A claim naming a dead
 * process is taken over, and says so.
 */
export function acquireSingleInstance(claimPath: string, port: number, io: SingleInstanceIo): AcquireResult {
  const existing = parseClaim(io.readClaim(claimPath));

  if (existing !== null && existing.pid !== io.selfPid && io.isAlive(existing.pid)) {
    return { ok: false, heldBy: existing };
  }

  const tookOverStale = existing !== null && !io.isAlive(existing.pid);
  if (tookOverStale) {
    log.warn("claim.stale-taken-over", {
      pid: existing?.pid,
      reason: "the pid in the claim file is not running — a previous instance did not shut down cleanly",
    });
  }

  const claim: InstanceClaim = { pid: io.selfPid, port, startedAt: io.now() };
  io.writeClaim(claimPath, JSON.stringify(claim));
  log.info("claim.acquired", { pid: claim.pid, port: claim.port, path: claimPath });

  let released = false;
  return {
    ok: true,
    tookOverStale,
    release: () => {
      // Idempotent: shutdown can be reached from SIGINT, SIGTERM and an error
      // path, and a double release must not delete a claim a SUCCESSOR wrote.
      if (released) return;
      released = true;
      const current = parseClaim(io.readClaim(claimPath));
      if (current !== null && current.pid !== io.selfPid) {
        log.warn("claim.release-skipped", {
          holder: current.pid,
          reason: "the claim file names another process — not ours to remove",
        });
        return;
      }
      io.removeClaim(claimPath);
      log.info("claim.released", { pid: io.selfPid });
    },
  };
}

/** The operator-facing message for a refused start. Names the holder and the
 *  exact command that resolves it — a bare "address in use" leaves the reader
 *  to work out which of dev, prod or a leftover process is the winner. */
export function describeConflict(heldBy: InstanceClaim, port: number, now: number): string {
  const uptimeSec = heldBy.startedAt > 0 ? Math.round((now - heldBy.startedAt) / 1000) : null;
  const uptime = uptimeSec === null ? "unknown uptime" : `up ${uptimeSec}s`;
  return [
    `another sentient gateway is already running (pid ${heldBy.pid}, port ${heldBy.port}, ${uptime}).`,
    "There must be exactly one instance per machine: it owns the per-user tool sockets,",
    "the session stores and the addon supervisor, and a second instance corrupts all three.",
    "",
    `  dev:   kill ${heldBy.pid}      # or stop the shell running 'bun run dev'`,
    "  prod:  sudo launchctl kickstart -k system/io.sentient.gateway",
    "",
    `This process wanted port ${port}.`,
  ].join("\n");
}
