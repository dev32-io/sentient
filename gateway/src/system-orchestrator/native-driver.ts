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

/** A live child. `exited` resolves with the exit code; the driver only awaits
 *  it to log, never to gate a lifecycle transition. */
export interface NativeProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: string): void;
}

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
  /** SIGTERM the whole process GROUP led by `pid`. Never throws. */
  killPid(pid: number): void;
  /** True while the group leader is still alive. */
  isPidAlive(pid: number): boolean;
}

export interface NativeDriver extends ServiceDriver {
  /** Kill every process recorded in a pid file. Called once at boot, BEFORE
   *  the first apply, so a gateway that was SIGKILLed cannot leave a child
   *  holding the port its replacement is about to bind. */
  reapOrphans(): Promise<void>;
}

export function createNativeDriver(deps: NativeDriverDeps): NativeDriver {
  // Last spec seen per service, so start() can re-launch after a stop().
  const known = new Map<ServiceName, NativeManagedService>();
  const running = new Map<ServiceName, NativeProcess>();

  async function prepare(ms: ManagedService): Promise<Result<undefined, DriverError>> {
    const native = requireNative(ms);
    if (!native.ok) return native;
    return verifyLaunchArtifact(deps, native.value);
  }

  async function spawnService(ms: NativeManagedService): Promise<Result<undefined, DriverError>> {
    const ready = await verifyLaunchArtifact(deps, ms);
    if (!ready.ok) return ready;

    await stopIfRunning(deps, running, ms.name);

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
    await deps.writePidFile(ms.name, proc.pid);
    log.info("native.started", { service: ms.name, pid: proc.pid, argc: ms.config.exec.length });
    watchExit(ms.name, proc, running);
    return { ok: true, value: undefined };
  }

  return {
    prepare,

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
        killChild(deps, name, pid);
        await deps.removePidFile(name);
      }
    },
  };
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
  if (proc) {
    log.info("native.stopping", { service: name, pid: proc.pid });
    killChild(deps, name, proc.pid);
    running.delete(name);
  }
  await deps.removePidFile(name);
}

function isPlausiblePid(pid: number): boolean {
  return Number.isInteger(pid) && pid >= MIN_PLAUSIBLE_PID;
}

/** The single choke point for every signal this driver sends. Both sources of
 *  a pid — the in-memory `running` map and the on-disk pid files — pass through
 *  here, so no lifecycle path can reach kill(2) with a pid that addresses the
 *  gateway's own process group. */
function killChild(deps: NativeDriverDeps, name: ServiceName, pid: number): void {
  if (!isPlausiblePid(pid)) {
    log.warn("native.kill-refused", { service: name, pid, reason: "pid cannot be a spawned child" });
    return;
  }
  deps.killPid(pid);
}

/** Log the exit and drop the handle. Restart is the orchestrator's call (a
 *  health probe failure re-applies), never the driver's — a driver-local
 *  restart loop would race the apply loop. */
function watchExit(name: ServiceName, proc: NativeProcess, running: Map<ServiceName, NativeProcess>): void {
  void proc.exited
    .then((code) => {
      if (running.get(name) === proc) running.delete(name);
      log.warn("native.exited", { service: name, pid: proc.pid, code, reason: "child process ended" });
    })
    .catch((err: unknown) => {
      log.warn("native.exit-watch-failed", { service: name, pid: proc.pid, reason: errMsg(err) });
    });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
