// HermesRunner (Plan 2 Task 5, spec §5.4) — the one-shot native-process
// invoke behind `delegateTask("hermes", …)`. Copies the `defaultShell`
// capture pattern from `admin/supervisord-control.ts:334-349` (Bun.spawn
// with piped stdout/stderr, `await proc.exited`, drain via
// `new Response(...).text()`) but adds what a one-shot LLM delegation needs
// that a supervisord control command does not: a bounded deadline
// (`delegation.hermes_timeout_ms`) and abort-signal propagation
// (`proc.kill()` on abort — never throw, per the AbortSignal decorator
// rule).
//
// CLI shape: `hermes -p <userId> -z <prompt>`. `-p` selects the per-user
// profile (profile-store's convention — the profile must already exist,
// provisioned out-of-band). `-z`/`--oneshot` is the installed Hermes CLI's
// one-shot flag: run a single prompt, print only the final response text to
// stdout, no banner/spinner/session-id line — exactly the shape a
// subprocess capture wants. `cwd` is the resolved profile dir: the one-shot
// flag's own help text notes tools/memory/rules/AGENTS.md load from the
// CWD, so this is not cosmetic — it is how per-user context reaches the
// worker.
//
// `spawn` is injected (default `Bun.spawn`) so the unit test can supply a
// fake process without ever spawning a real `hermes` binary.

import { getLog } from "../logging/logger.js";
import type { UserId } from "../user-auth/user-id.js";

const log = getLog(["sentient", "tools", "hermes-runner"]);

const HERMES_BIN = "hermes";
const PROFILE_FLAG = "-p";
const ONE_SHOT_FLAG = "-z";
const STDERR_PREVIEW_MAX = 500; // truncate captured stderr/stdout previews in the error message + logs

export type HermesRunResult = { ok: true; output: string } | { ok: false; error: string };

export interface HermesRunner {
  run(userId: UserId, prompt: string, signal: AbortSignal): Promise<HermesRunResult>;
}

/** What the runner actually drains via `new Response(...).text()` — real
 *  `Bun.spawn` output is a `ReadableStream`; the unit test's fake process
 *  hands back a plain string, both valid `BodyInit`s. */
export type ProcessOutput = ReadableStream<Uint8Array> | string;

/** The subset of `Bun.Subprocess` the runner actually touches — narrowed on
 *  purpose so the unit test's fake doesn't have to fabricate a full
 *  Subprocess (pid, stdin, resourceUsage, ...). */
export interface HermesProcess {
  readonly exited: Promise<number>;
  readonly stdout: ProcessOutput;
  readonly stderr: ProcessOutput;
  kill(): void;
}

export type SpawnFn = (
  argv: readonly string[],
  options: { cwd: string; stdout: "pipe"; stderr: "pipe" },
) => HermesProcess;

export interface HermesRunnerDeps {
  resolveProfileDir(userId: string): string;
  /** Deadline for a single invocation (ms) — `delegation.hermes_timeout_ms`. */
  timeoutMs: number;
  spawn?: SpawnFn;
}

function truncate(text: string): string {
  return text.length > STDERR_PREVIEW_MAX ? `${text.slice(0, STDERR_PREVIEW_MAX)}…` : text;
}

export function createHermesRunner(deps: HermesRunnerDeps): HermesRunner {
  const { resolveProfileDir, timeoutMs } = deps;
  const spawn = deps.spawn ?? ((argv, options) => Bun.spawn([...argv], options) as unknown as HermesProcess);

  async function run(userId: UserId, prompt: string, signal: AbortSignal): Promise<HermesRunResult> {
    if (signal.aborted) {
      log.info("hermes-runner.run.already-aborted", { userId });
      return { ok: false, error: "aborted before start" };
    }

    const cwd = resolveProfileDir(userId);
    const argv = [HERMES_BIN, PROFILE_FLAG, userId, ONE_SHOT_FLAG, prompt];
    const startedAt = Date.now();
    log.info("hermes-runner.run.start", { userId, cwd, timeoutMs });

    let proc: HermesProcess;
    try {
      proc = spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("hermes-runner.run.spawn-failed", { userId, reason });
      return { ok: false, error: `spawn failed: ${reason}` };
    }

    let timedOut = false;
    const onAbort = () => {
      log.warn("hermes-runner.run.aborted", { userId, elapsedMs: Date.now() - startedAt });
      proc.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      log.warn("hermes-runner.run.timeout", { userId, timeoutMs });
      proc.kill();
    }, timeoutMs);

    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const elapsedMs = Date.now() - startedAt;

      if (signal.aborted) {
        log.info("hermes-runner.run.done-after-abort", { userId, elapsedMs });
        return { ok: false, error: "aborted" };
      }
      if (timedOut) {
        log.warn("hermes-runner.run.done-after-timeout", { userId, elapsedMs, timeoutMs });
        return { ok: false, error: `hermes invocation timed out after ${timeoutMs}ms` };
      }
      if (code !== 0) {
        const reason = truncate(stderr || stdout) || `exit code ${code}`;
        log.warn("hermes-runner.run.non-zero-exit", { userId, code, elapsedMs, reasonLength: reason.length });
        return { ok: false, error: reason };
      }

      log.info("hermes-runner.run.ok", { userId, elapsedMs, outputLength: stdout.length });
      return { ok: true, output: stdout };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  return { run };
}
