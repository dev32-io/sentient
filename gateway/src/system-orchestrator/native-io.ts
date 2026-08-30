// Real OS bindings for the native driver. Kept in its own module so
// native-driver.ts stays a pure state machine over an injected seam and its
// unit tests never spawn a process or touch the filesystem.
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../logging/logger.js";
import {
  MIN_PLAUSIBLE_PID,
  type NativeDriverDeps,
  type NativeKillSignal,
  type NativePidRecord,
  type NativeProcess,
  type NativeSpawnOptions,
} from "./native-driver.js";
import type { ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "native-io"]);

/** `<name>.pid` — one file per managed native service. */
const PID_FILE_SUFFIX = ".pid";
/** Deadline for `<interpreter> --version`. A local exec that has not answered
 *  in this long is wedged, not slow. Matches the fixed-deadline precedent set
 *  by SERVICE_HEALTH_TIMEOUT_MS in this module's sibling factory. */
const VERSION_PROBE_TIMEOUT_MS = 5000;
/** Exit code reported when the child was killed by a signal rather than
 *  exiting normally, so `exited` always resolves with a number. */
const EXIT_CODE_SIGNALLED = -1;
/** Deadline for the two local process-table lookups (`lsof`, `ps`). Same
 *  fixed-deadline rationale as VERSION_PROBE_TIMEOUT_MS: a local exec that has
 *  not answered in this long is wedged, and a health probe must never block on
 *  it. Kept short because it runs on every watchdog tick. */
const LSOF_TIMEOUT_MS = 3000;
/** Cap on the argv preview of a foreign port holder. Under the ≤120-char log
 *  preview rule, and it names a process, so it is truncated on principle. */
const PROCESS_DESCRIPTION_CHARS = 120;
/** Bytes of a child's stderr retained for the exit reason. Large enough to hold
 *  a python traceback (whose LAST line is the exception), small enough that a
 *  chatty service cannot grow the gateway's heap. */
const STDERR_RING_CHARS = 4096;

const PYTHON_VERSION_RE = /(\d+\.\d+\.\d+)/;

export interface NativeIOOptions {
  /** User-owned, mutable dir holding one pid file per native service. */
  runDir: string;
}

export function createNativeIO(opts: NativeIOOptions): NativeDriverDeps {
  return {
    spawn: (cmd, spawnOpts) => spawnDetached(cmd, spawnOpts),
    isExecutable,
    probeInterpreterVersion,
    writePidFile: (name, pid) => writePidFile(opts.runDir, name, pid),
    readPidFiles: () => readPidFiles(opts.runDir),
    removePidFile: (name) => removePidFile(opts.runDir, name),
    killPid,
    isPidAlive,
    listeningPidFor,
    describePid,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` -> the pid owning the listening
 *  socket. Exit 1 with no output is lsof's "no match", i.e. nothing listens —
 *  a normal answer, not a failure. Only ONE pid is returned: two processes
 *  cannot hold the same loopback listener without SO_REUSEPORT, which neither
 *  native service sets, so a multi-line answer means the port is not what we
 *  think it is and attributing it to the first line would be a guess. */
function listeningPidFor(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: LSOF_TIMEOUT_MS }, (_err, stdout) => {
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length !== 1) {
        if (lines.length > 1) {
          log.warn("io.listener-ambiguous", { port, count: lines.length, reason: "more than one listening pid" });
        }
        resolve(null);
        return;
      }
      const pid = Number.parseInt(lines[0] ?? "", 10);
      resolve(Number.isInteger(pid) && pid >= MIN_PLAUSIBLE_PID ? pid : null);
    });
  });
}

/** `ps -o command= -p <pid>`, truncated, so a refusal can NAME the process it
 *  refused to adopt. Never throws — an unreadable process is `null`. */
function describePid(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: LSOF_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const cmd = stdout.trim().slice(0, PROCESS_DESCRIPTION_CHARS);
      resolve(cmd.length > 0 ? cmd : null);
    });
  });
}

function spawnDetached(cmd: string[], opts: NativeSpawnOptions): NativeProcess {
  const [bin, ...args] = cmd;
  if (bin === undefined) throw new Error("native spawn requires a non-empty argv");

  const child = spawn(bin, args, {
    // Own process group, so a later boot can signal the whole tree by -pgid.
    detached: opts.detached,
    // The child inherits the gateway's env plus its own overrides; a native
    // service needs PATH and HOME to find its venv and model cache.
    env: { ...process.env, ...opts.env },
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Do not hold the gateway's event loop open on this child.
  child.unref();

  pipeOutputMetrics(child.stdout, bin, "stdout");
  // stderr is also retained in a bounded ring for internal exit recovery. Raw
  // subprocess output is never copied into this module's logs.
  const stderrRing = createStderrRing();
  pipeOutputMetrics(child.stderr, bin, "stderr", stderrRing.push);

  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? EXIT_CODE_SIGNALLED));
    child.once("error", (err: unknown) => {
      log.warn("io.child-error", { bin, errorClass: safeErrorClass(err) });
      resolve(EXIT_CODE_SIGNALLED);
    });
  });

  // An exec-time failure (missing binary, EACCES, broken shebang) does NOT
  // throw from spawn(): node leaves `pid` undefined and emits 'error' later.
  // The listener above is already attached, so that late event is handled;
  // what must not happen is returning a process whose pid was invented, which
  // would record a launch that never occurred. The driver turns this into a
  // spawn-failed Result.
  if (child.pid === undefined) {
    log.warn("io.spawn-no-pid", { bin, reason: "exec failed; node reports the cause asynchronously" });
    throw new Error(`spawn produced no pid for ${bin}`);
  }

  return {
    pid: child.pid,
    exited,
    kill: (signal?: string) => {
      child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
    },
    stderrTail: stderrRing.read,
  };
}

/** Last `STDERR_RING_CHARS` of a child's stderr. Bounded so a service that logs
 *  at DEBUG for a week cannot grow the gateway's heap; tail rather than head so
 *  the retained text is the exception, not the banner that preceded it. */
function createStderrRing(): { push: (text: string) => void; read: () => string } {
  let buffer = "";
  return {
    push: (text: string) => {
      buffer = (buffer + text).slice(-STDERR_RING_CHARS);
    },
    read: () => buffer,
  };
}

function pipeOutputMetrics(
  stream: NodeJS.ReadableStream | null,
  bin: string,
  channel: "stdout" | "stderr",
  retain?: (text: string) => void,
): void {
  if (!stream) return;
  let bytes = 0;
  let chunks = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    chunks += 1;
    retain?.(chunk.toString("utf8"));
  });
  stream.once("end", () => {
    if (chunks > 0) log.debug("io.child-output-summary", { bin, channel, bytes, chunks });
  });
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `<interpreter> --version` -> "Python 3.11.9" -> "3.11.9". Returns null when
 *  the probe fails or prints something unparseable; the driver treats null as
 *  a hard prepare failure rather than assuming a match. */
async function probeInterpreterVersion(interpreter: string): Promise<string | null> {
  const output = await runVersionProbe(interpreter);
  if (output === null) return null;
  const match = PYTHON_VERSION_RE.exec(output);
  if (!match?.[1]) {
    log.warn("io.version-unparseable", { interpreter, reason: "no major.minor.patch in --version output" });
    return null;
  }
  return match[1];
}

function runVersionProbe(interpreter: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(interpreter, ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        log.warn("io.version-probe-failed", { interpreter, errorClass: safeErrorClass(err) });
        resolve(null);
        return;
      }
      // Python <3.4 printed the version on stderr; tolerate both.
      resolve(`${stdout}${stderr}`);
    });
  });
}

function pidPath(runDir: string, name: ServiceName): string {
  return join(runDir, `${name}${PID_FILE_SUFFIX}`);
}

async function writePidFile(runDir: string, name: ServiceName, pid: number): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(pidPath(runDir, name), String(pid), "utf8");
  log.debug("io.pid-written", { service: name, pid });
}

async function readPidFiles(runDir: string): Promise<NativePidRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch {
    // No run dir yet — first boot. Not a fallback, just an empty set.
    return [];
  }

  const records: NativePidRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(PID_FILE_SUFFIX)) continue;
    const name = entry.slice(0, -PID_FILE_SUFFIX.length);
    const pid = await readPid(join(runDir, entry), name);
    if (pid !== null) records.push({ name, pid });
  }
  return records;
}

async function readPid(path: string, name: ServiceName): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (Number.isInteger(pid) && pid >= MIN_PLAUSIBLE_PID) return pid;
    log.warn("io.pid-file-invalid", { service: name, reason: "not a plausible pid" });
    return null;
  } catch (err) {
    log.warn("io.pid-file-unreadable", { service: name, reason: errMsg(err) });
    return null;
  }
}

async function removePidFile(runDir: string, name: ServiceName): Promise<void> {
  try {
    await unlink(pidPath(runDir, name));
    log.debug("io.pid-removed", { service: name });
  } catch {
    // Already gone — removal is idempotent by design.
  }
}

/** Signal the whole process GROUP led by `pid` (negative pid = group). The
 *  group is why detached spawning matters: it takes down a python service's
 *  own worker children too. Falls back to the single pid when the group is
 *  already gone. Never throws — a dead pid is the desired end state. */
function killPid(pid: number, signal: NativeKillSignal = "SIGTERM"): void {
  // Last line of defence at the syscall itself: `-0 === 0` in JS, so kill(-0)
  // is kill(0), which POSIX defines as "signal the CALLER's whole process
  // group" — the gateway would SIGTERM itself. Refuse below MIN_PLAUSIBLE_PID.
  if (!Number.isInteger(pid) || pid < MIN_PLAUSIBLE_PID) {
    log.warn("io.kill-refused", { pid, reason: "pid addresses the caller's own group or init, not a child" });
    return;
  }
  try {
    process.kill(-pid, signal);
    log.info("io.group-terminated", { pid, signal });
    return;
  } catch (err) {
    log.debug("io.group-kill-failed", { pid, signal, reason: errMsg(err) });
  }
  try {
    process.kill(pid, signal);
    log.info("io.pid-terminated", { pid, signal });
  } catch (err) {
    log.debug("io.pid-kill-failed", { pid, signal, reason: errMsg(err) });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeErrorClass(err: unknown): "error" | "non-error" {
  return err instanceof Error ? "error" : "non-error";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
