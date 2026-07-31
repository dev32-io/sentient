// Native launch backend for the system orchestrator. Mirrors docker-driver's
// lifecycle so everything above the driver — dep-graph, health polling,
// boot reconciliation — stays backend-agnostic.
//
// PROCESS GROUPS: children are spawned detached, i.e. into their own process
// group, and their pids are written to disk. The gateway cannot run a shutdown
// hook when SIGKILLed, so without this a killed gateway would leave whisper-stt
// and local-tts running and the next boot would fail to bind their ports.
// reapOrphans() at boot closes that hole.
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { probePort } from "./health.js";
import {
  type DriverError,
  type ManagedProcessInfo,
  type ManagedService,
  type NativeManagedService,
  type ServiceDriver,
  type ServiceName,
  isNativeService,
} from "./types.js";

const log = getLog(["sentient", "system-orch", "native-driver"]);

/** The lowest pid that can possibly be a child this driver spawned. kill(2)
 *  reads pid 0 as "every process in the CALLER's own process group" and pid 1
 *  as init/launchd, so signalling either would take down the gateway itself
 *  instead of a service. Anything below this is refused, never signalled. */
export const MIN_PLAUSIBLE_PID = 2;

/** The only two signals this driver sends. SIGTERM asks; SIGKILL is the bounded
 *  escalation for a child of OURS that ignored the ask. */
export type NativeKillSignal = "SIGTERM" | "SIGKILL";

/** A live child. `exited` resolves with the exit code; the driver only awaits
 *  it to log, never to gate a lifecycle transition. */
export interface NativeProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: string): void;
  /** The child's most recent stderr output, so an exit can say WHY. Empty when
   *  the child printed nothing. The driver truncates before logging. */
  stderrTail(): string;
}

/** Why a service's last child stopped. Kept after the process handle is gone so
 *  a later "no live child" verdict can name the cause instead of just the
 *  absence — a supervisor that reports "not running" without the exit reason
 *  sends the operator to a log that was never written. */
interface LastExit {
  pid: number;
  code: number;
  stderr: string;
}

/** Cap on the stderr excerpt carried into a log line or an error reason. The
 *  house rule caps previews at 120 chars; a python traceback is far longer. */
const STDERR_REASON_CHARS = 120;

export interface NativeSpawnOptions {
  /** Always true — see the file header. Kept explicit so the seam is testable. */
  detached: boolean;
  env: Record<string, string>;
  cwd?: string;
  stdout: "pipe";
  stderr: "pipe";
}

export interface NativePidRecord {
  name: ServiceName;
  pid: number;
}

/** Every OS interaction the driver needs, injected so the unit tests never
 *  spawn a real process or write a real file. */
export interface NativeDriverDeps {
  spawn(cmd: string[], opts: NativeSpawnOptions): NativeProcess;
  /** True when `path` exists and is executable by this process. */
  isExecutable(path: string): Promise<boolean>;
  /** The interpreter's own reported version ("3.11.9"), or null if unreadable. */
  probeInterpreterVersion(interpreter: string): Promise<string | null>;
  writePidFile(name: ServiceName, pid: number): Promise<void>;
  readPidFiles(): Promise<NativePidRecord[]>;
  removePidFile(name: ServiceName): Promise<void>;
  /** Signal the whole process GROUP led by `pid`, SIGTERM unless told
   *  otherwise. Never throws. */
  killPid(pid: number, signal?: NativeKillSignal): void;
  /** True while the group leader is still alive. */
  isPidAlive(pid: number): boolean;
  /** The pid owning the LISTENING socket on `port`, or null when nothing
   *  listens. This is the identity half of the health contract — see
   *  ServiceDriver.verifyIdentity. */
  listeningPidFor(port: number): Promise<number | null>;
  /** A short argv description of `pid`, for naming a foreign holder in a log
   *  line. Null when the process is gone or unreadable. */
  describePid(pid: number): Promise<string | null>;
  sleep(ms: number): Promise<void>;
}

/** Fallbacks for the two port-settle knobs. The real values are operator-tunable
 *  in `config.yaml#system_orchestrator` and the gateway always passes both
 *  explicitly; these exist only so the driver is constructible standalone.
 *  (Same arrangement as health-watch.ts's back-off defaults.) */
const DEFAULT_PORT_SETTLE_TIMEOUT_MS = 8000;
const DEFAULT_PORT_SETTLE_POLL_MS = 250;

export interface NativeDriverOptions {
  /** How long to wait for a service's declared port to be released after its
   *  previous holder was signalled, before giving up on the launch. */
  portSettleTimeoutMs?: number;
  /** How often the port is re-checked while waiting. */
  portSettlePollMs?: number;
}

export interface NativeDriver extends ServiceDriver {
  /** Kill every process recorded in a pid file. Called once at boot, BEFORE
   *  the first apply, so a gateway that was SIGKILLed cannot leave a child
   *  holding the port its replacement is about to bind. */
  reapOrphans(): Promise<void>;
}

export function createNativeDriver(deps: NativeDriverDeps, options: NativeDriverOptions = {}): NativeDriver {
  const settleTimeoutMs = options.portSettleTimeoutMs ?? DEFAULT_PORT_SETTLE_TIMEOUT_MS;
  const settlePollMs = options.portSettlePollMs ?? DEFAULT_PORT_SETTLE_POLL_MS;
  // Last spec seen per service, so start() can re-launch after a stop().
  const known = new Map<ServiceName, NativeManagedService>();
  const running = new Map<ServiceName, NativeProcess>();
  const lastExit = new Map<ServiceName, LastExit>();
  // ═══ THE OWNERSHIP RECORD, and the whole basis for deciding what may be
  // killed. A pid lands here only because THIS driver spawned it, or because it
  // was read out of a pid file THIS gateway wrote under its own state root.
  //
  // Everything else on a port is refused and named, never signalled. That
  // boundary is not caution for its own sake: on the dev box the holder was a
  // legacy `io.dev32.sentient.whisper-stt` LaunchAgent with KeepAlive=true and
  // an argv byte-identical to ours, so an argv- or port-based kill rule would
  // have entered an unbounded kill/respawn duel with launchd — taking STT down
  // for the household while the log filled with successful-looking reaps.
  // A refusal is loud, bounded and self-healing: the service is marked failed
  // with the holder named, the watchdog keeps probing cheaply, and the next
  // apply succeeds the moment the holder goes away.
  const ourPids = new Set<number>();

  async function prepare(ms: ManagedService): Promise<Result<undefined, DriverError>> {
    const native = requireNative(ms);
    if (!native.ok) return native;
    return verifyLaunchArtifact(deps, native.value);
  }

  async function spawnService(ms: NativeManagedService): Promise<Result<undefined, DriverError>> {
    const ready = await verifyLaunchArtifact(deps, ms);
    if (!ready.ok) return ready;

    await stopIfRunning(deps, running, ms.name);
    // Never launch onto a socket someone still holds: a doomed child that dies
    // on EADDRINUSE is exactly the crash loop this task exists to end, and the
    // holder's identity is the one thing the log must carry.
    const free = await waitForPortFree(ms);
    if (!free.ok) return free;

    let proc: NativeProcess;
    try {
      proc = deps.spawn([...ms.config.exec], {
        // Own process group — see the file header.
        detached: true,
        env: ms.config.env,
        ...(ms.config.cwd === undefined ? {} : { cwd: ms.config.cwd }),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const reason = errMsg(err);
      log.warn("native.spawn-failed", { service: ms.name, reason });
      return { ok: false, error: { kind: "spawn-failed", reason } };
    }

    // A backend cannot always produce a real pid: node leaves `child.pid`
    // undefined when exec fails and only reports it on a later 'error' event.
    // Recording that as running would report a launch that never happened and
    // leave an unsignallable pid in the map — see MIN_PLAUSIBLE_PID.
    if (!isPlausiblePid(proc.pid)) {
      const reason = `spawn returned no usable pid (${proc.pid})`;
      log.warn("native.spawn-no-pid", { service: ms.name, pid: proc.pid, reason });
      return { ok: false, error: { kind: "spawn-failed", reason } };
    }

    known.set(ms.name, ms);
    running.set(ms.name, proc);
    ourPids.add(proc.pid);
    await deps.writePidFile(ms.name, proc.pid);
    lastExit.delete(ms.name);
    log.info("native.started", { service: ms.name, pid: proc.pid, argc: ms.config.exec.length });
    watchExit(ms.name, proc, running, lastExit);
    return { ok: true, value: undefined };
  }

  /**
   * Blocks until the service's declared port is free, or refuses.
   *
   * The two outcomes are deliberately asymmetric, because the two situations
   * are: a holder that is OURS is a cleanup problem (signal it harder, wait for
   * the socket to actually close — TCP does not release it the instant the
   * process is signalled), while a holder that is NOT ours is a decision no
   * unattended process should take on the operator's machine.
   */
  async function waitForPortFree(ms: NativeManagedService): Promise<Result<undefined, DriverError>> {
    const port = probePort(ms.config.healthcheck);
    if (port === null) return { ok: true, value: undefined };

    let escalated = false;
    for (let waitedMs = 0; ; waitedMs += settlePollMs) {
      const holder = await deps.listeningPidFor(port);
      if (holder === null) {
        if (waitedMs > 0) log.info("native.port-settled", { service: ms.name, port, waitedMs });
        return { ok: true, value: undefined };
      }
      if (!(await isOurs(ms.name, holder))) return portHeld(deps, ms.name, port, holder);
      if (waitedMs >= settleTimeoutMs) {
        return portHeld(deps, ms.name, port, holder, "it is ours but did not release the socket");
      }
      // Ours, still holding. Signal it on the FIRST pass too: the holder may be
      // a survivor this process never spawned (children are detached, so they
      // outlive a killed gateway) and nothing has asked it to stop yet.
      // Escalate to SIGKILL once, halfway through the budget.
      const escalate: boolean = !escalated && waitedMs * 2 >= settleTimeoutMs;
      if (waitedMs === 0 || escalate) {
        escalated = escalated || escalate;
        log.warn(escalate ? "native.kill-escalated" : "native.port-holder-signalled", {
          service: ms.name,
          pid: holder,
          port,
          reason: escalate ? "our own child still held the port after SIGTERM" : "our own child still holds the port",
        });
        killChild(deps, ms.name, holder, escalate ? "SIGKILL" : "SIGTERM");
      }
      await deps.sleep(settlePollMs);
    }
  }

  /**
   * Ownership, over BOTH records — the in-memory handle and the pid file.
   *
   * The pid file is the durable half and the restart case needs it: children
   * are detached on purpose so a SIGKILLed gateway does not take the household's
   * STT down with it, which means the replacement gateway meets a live child it
   * never spawned. Its own `running` map is empty; only `~/.sentient/run/<svc>.pid`
   * still says that process is ours. Reading in-memory FIRST keeps the common
   * path free of a filesystem hit.
   *
   * Scoped to the service's OWN pid file, not to any of them, so a stale record
   * for whisper-stt can never authorise signalling something on local-tts's port.
   */
  async function isOurs(name: ServiceName, pid: number): Promise<boolean> {
    if (ourPids.has(pid)) return true;
    const records = await deps.readPidFiles();
    const owned = records.some((r) => r.name === name && r.pid === pid);
    if (owned) {
      log.info("native.ownership-from-pid-file", {
        service: name,
        pid,
        reason: "a child of a previous gateway process survived; the pid file still records it",
      });
      ourPids.add(pid);
    }
    return owned;
  }

  /** Health is liveness AND identity. Everything here answers one question:
   *  is the thing on the other end of that socket the child WE started? */
  async function verifyIdentity(ms: ManagedService): Promise<Result<undefined, DriverError>> {
    const native = requireNative(ms);
    if (!native.ok) return native;
    const name = native.value.name;
    const ourPid = running.get(name)?.pid ?? null;
    const port = probePort(native.value.config.healthcheck);
    const died = describeLastExit(lastExit.get(name));

    if (port === null) return verifyByPidRecord(deps, name, ourPid, died);

    const holder = await deps.listeningPidFor(port);
    if (holder === null) return identityFailed(name, `nothing is listening on port ${port}${died}`);
    if (holder !== ourPid) {
      const cmd = (await deps.describePid(holder)) ?? "unreadable";
      const ours = ourPid === null ? `this gateway started no child for it${died}` : `not our child pid ${ourPid}`;
      return identityFailed(name, `foreign listener on port ${port}: pid ${holder} (${cmd}), ${ours}`);
    }

    log.debug("native.identity-ok", { service: name, port, pid: ourPid });
    return { ok: true, value: undefined };
  }

  return {
    prepare,
    verifyIdentity,

    recreate: async (ms) => {
      const native = requireNative(ms);
      if (!native.ok) return native;
      return spawnService(native.value);
    },

    start: async (name) => {
      const ms = known.get(name);
      if (!ms) {
        const reason = `no launch spec recorded for ${name}`;
        log.warn("native.start-unknown", { service: name, reason });
        return { ok: false, error: { kind: "start-failed", reason } };
      }
      return spawnService(ms);
    },

    stop: async (name) => {
      await stopIfRunning(deps, running, name);
      return { ok: true, value: undefined };
    },

    remove: async (name) => {
      await stopIfRunning(deps, running, name);
      known.delete(name);
      return { ok: true, value: undefined };
    },

    listManaged: async (): Promise<ManagedProcessInfo[]> => {
      const records = await deps.readPidFiles();
      const live = records.filter((r) => deps.isPidAlive(r.pid));
      log.debug("native.listed", { total: records.length, live: live.length });
      // `id` is the service name, not the pid: it is what remove() accepts.
      return live.map((r) => ({ id: r.name, service: r.name, state: "running" }));
    },

    reapOrphans: async (): Promise<void> => {
      const records = await deps.readPidFiles();
      for (const { name, pid } of records) {
        log.warn("native.orphan-reaped", {
          service: name,
          pid,
          reason: "pid file survived a gateway restart",
        });
        // A pid file this gateway wrote is the ownership record: claim the pid
        // BEFORE signalling it, so the port wait that follows knows this holder
        // is ours to escalate on rather than a foreign process to refuse.
        if (isPlausiblePid(pid)) ourPids.add(pid);
        killChild(deps, name, pid);
        // SIGTERM is asynchronous, so the record is kept while the process it
        // names is still winding down. Dropping it there is how the ownership
        // evidence is lost: a gateway that then dies before its child leaves a
        // successor with nothing to prove that survivor is ours, and it refuses
        // its own port forever. A successful spawn overwrites the file anyway.
        if (deps.isPidAlive(pid)) {
          log.info("native.pid-file-kept", { service: name, pid, reason: "process still alive after SIGTERM" });
          continue;
        }
        await deps.removePidFile(name);
      }
    },
  };
}

/** The clause appended to every "nothing of ours is there" verdict. Empty when
 *  no child of ours has exited, so a first boot does not carry a stale cause. */
function describeLastExit(exit: LastExit | undefined): string {
  if (exit === undefined) return "";
  const why = exit.stderr.length > 0 ? `: ${exit.stderr}` : "";
  return ` — our last child (pid ${exit.pid}) exited code=${exit.code}${why}`;
}

/** The last non-empty stderr line, truncated. A python traceback's LAST line is
 *  the exception; its first is boilerplate, so a head-truncated preview would
 *  reliably cut off the one sentence that says what went wrong. */
function lastStderrLine(tail: string): string {
  const lines = tail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return (lines[lines.length - 1] ?? "").slice(0, STDERR_REASON_CHARS);
}

function identityFailed(name: ServiceName, reason: string): Result<undefined, DriverError> {
  log.warn("native.identity-failed", { service: name, reason });
  return { ok: false, error: { kind: "identity-failed", reason } };
}

/** A refusal to launch, with the holder NAMED. ERROR rather than WARN: it needs
 *  a human, and the pid + argv are the whole point — an operator who cannot
 *  identify the holder cannot clear it. */
async function portHeld(
  deps: NativeDriverDeps,
  name: ServiceName,
  port: number,
  holder: number,
  qualifier = "it is not a child of this gateway, so it was NOT signalled",
): Promise<Result<undefined, DriverError>> {
  const cmd = (await deps.describePid(holder)) ?? "unreadable";
  const reason = `port ${port} is held by pid ${holder} (${cmd}) — ${qualifier}`;
  log.error("native.port-held", { service: name, port, holder, reason });
  return { ok: false, error: { kind: "port-held", reason } };
}

/** Fallback for a service whose probe names no port (`noop`, `exec`): there is
 *  no socket to attribute, so the strongest honest claim left is "the child we
 *  recorded is still alive". Never a bare pass — an unchecked check reporting
 *  healthy is the defect this whole seam exists to close. */
function verifyByPidRecord(
  deps: NativeDriverDeps,
  name: ServiceName,
  ourPid: number | null,
  died: string,
): Result<undefined, DriverError> {
  if (ourPid === null) {
    return identityFailed(name, `no child recorded and the healthcheck names no port to attribute${died}`);
  }
  if (!deps.isPidAlive(ourPid)) {
    return identityFailed(name, `our recorded child pid ${ourPid} is not alive`);
  }
  log.debug("native.identity-ok-by-pid", { service: name, pid: ourPid, reason: "healthcheck names no port" });
  return { ok: true, value: undefined };
}

/** Fail closed when a docker service reaches the native driver. A model- or
 *  config-driven mix-up must never spawn something the argv does not describe. */
function requireNative(ms: ManagedService): Result<NativeManagedService, DriverError> {
  if (isNativeService(ms)) return { ok: true, value: ms };
  const reason = `service ${ms.name} is launch=${ms.config.launch}, not native`;
  log.warn("native.wrong-backend", { service: ms.name, reason });
  return { ok: false, error: { kind: "wrong-backend", reason } };
}

/** The native analogue of pulling an image: prove the launch artifact exists
 *  and, when the config pins an interpreter, that argv[0] IS that interpreter.
 *  local-tts on 3.14 would import-crash at runtime; catching it here turns a
 *  mystery crash loop into one prepare-failed line. */
async function verifyLaunchArtifact(
  deps: NativeDriverDeps,
  ms: NativeManagedService,
): Promise<Result<undefined, DriverError>> {
  const interpreter = ms.config.exec[0];
  if (!(await deps.isExecutable(interpreter))) {
    const reason = `argv[0] is not an executable file: ${interpreter}`;
    log.warn("native.prepare-failed", { service: ms.name, reason });
    return { ok: false, error: { kind: "prepare-failed", reason } };
  }

  const pinned = ms.config.python;
  if (pinned === undefined) return { ok: true, value: undefined };

  const actual = await deps.probeInterpreterVersion(interpreter);
  if (actual === null || !matchesPinnedVersion(actual, pinned)) {
    const reason = `pinned python ${pinned}, interpreter reports ${actual ?? "unknown"}`;
    log.warn("native.prepare-failed", { service: ms.name, reason });
    return { ok: false, error: { kind: "prepare-failed", reason } };
  }

  log.debug("native.prepared", { service: ms.name, python: actual });
  return { ok: true, value: undefined };
}

/** A pin is major.minor; the host owns the patch level. */
function matchesPinnedVersion(actual: string, pinned: string): boolean {
  return actual === pinned || actual.startsWith(`${pinned}.`);
}

async function stopIfRunning(
  deps: NativeDriverDeps,
  running: Map<ServiceName, NativeProcess>,
  name: ServiceName,
): Promise<void> {
  const proc = running.get(name);
  // The pid file is removed ONLY when we actually stopped the child it names.
  // Removing it unconditionally destroyed the ownership record of a child this
  // process never spawned but which was still running (the restart case), and
  // every attempt after that read its own predecessor's child as a foreign
  // holder and refused — a permanent wedge. A successful spawn overwrites the
  // file anyway, so nothing needs the eager delete.
  if (!proc) return;
  log.info("native.stopping", { service: name, pid: proc.pid });
  killChild(deps, name, proc.pid);
  running.delete(name);
  await deps.removePidFile(name);
}

function isPlausiblePid(pid: number): boolean {
  return Number.isInteger(pid) && pid >= MIN_PLAUSIBLE_PID;
}

/** The single choke point for every signal this driver sends. Both sources of
 *  a pid — the in-memory `running` map and the on-disk pid files — pass through
 *  here, so no lifecycle path can reach kill(2) with a pid that addresses the
 *  gateway's own process group. */
function killChild(deps: NativeDriverDeps, name: ServiceName, pid: number, signal?: NativeKillSignal): void {
  if (!isPlausiblePid(pid)) {
    log.warn("native.kill-refused", { service: name, pid, reason: "pid cannot be a spawned child" });
    return;
  }
  deps.killPid(pid, signal);
}

/** Log the exit and drop the handle. Restart is never the driver's call — a
 *  driver-local restart loop would race the apply loop. It belongs to
 *  health-watch.ts, which probes each service on a timer and re-applies the
 *  ones that have gone unhealthy. (This comment used to claim "a health probe
 *  failure re-applies" while nothing outside the apply path ever re-probed, so
 *  a crashed addon stayed dead. The watchdog is what made the claim true.) */
function watchExit(
  name: ServiceName,
  proc: NativeProcess,
  running: Map<ServiceName, NativeProcess>,
  lastExit: Map<ServiceName, LastExit>,
): void {
  void proc.exited
    .then((code) => {
      if (running.get(name) === proc) running.delete(name);
      // The child's OWN last words. Without this the line read "child process
      // ended", the real cause (an EADDRINUSE traceback) went to DEBUG that
      // production never enables, and the defect survived a whole branch.
      const stderr = lastStderrLine(proc.stderrTail());
      lastExit.set(name, { pid: proc.pid, code, stderr });
      log.warn("native.exited", {
        service: name,
        pid: proc.pid,
        code,
        reason: stderr.length > 0 ? stderr : "child process ended with no stderr output",
      });
    })
    .catch((err: unknown) => {
      log.warn("native.exit-watch-failed", { service: name, pid: proc.pid, reason: errMsg(err) });
    });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
