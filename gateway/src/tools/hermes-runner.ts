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
// CLI shape: `hermes -p <delegationProfile> -z <prompt>`, with `cwd` set to the
// CALLING user's own profile dir. The two are deliberately different things:
//
//   * `-p` picks the Hermes profile, which is where the provider credential
//     lives. It used to be the userId. `hermes profile create --clone-from
//     default` copies that credential at a point in time and nothing re-syncs
//     it, so reconfiguring Hermes leaves earlier clones stale — measured
//     2026-07-31, one of three per-user profiles answered `HTTP 401: User not
//     found.` to every delegation. Interim decision (owner, same day): run the
//     operator's configured profile, `orchestrator.delegation.
//     hermes_delegation_profile`. Per-user isolation for delegated agents is
//     product design and gets its own spec.
//   * `cwd` stays the caller's profile dir, because `-z`'s own help text notes
//     that tools/memory/rules/AGENTS.md load from the CWD. That is how per-user
//     context still reaches the worker even though the credential is shared.
//
// `-z`/`--oneshot` runs a single prompt and prints only the final response text
// to stdout — no banner, spinner or session-id line — exactly the shape a
// subprocess capture wants.
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
  /** `orchestrator.delegation.hermes_delegation_profile` — the Hermes profile
   *  every delegation runs under, and therefore whose credential it uses. See
   *  the file header for why this is not the userId. */
  profile: string;
  resolveProfileDir(userId: string): string;
  /** Deadline for a single invocation (ms) — `delegation.hermes_timeout_ms`. */
  timeoutMs: number;
  spawn?: SpawnFn;
}

function truncate(text: string): string {
  return text.length > STDERR_PREVIEW_MAX ? `${text.slice(0, STDERR_PREVIEW_MAX)}…` : text;
}

export function createHermesRunner(deps: HermesRunnerDeps): HermesRunner {
  const { profile, resolveProfileDir, timeoutMs } = deps;
  const spawn = deps.spawn ?? ((argv, options) => Bun.spawn([...argv], options) as unknown as HermesProcess);

  async function run(userId: UserId, prompt: string, signal: AbortSignal): Promise<HermesRunResult> {
    if (signal.aborted) {
      log.info("hermes-runner.run.already-aborted", { userId });
      return { ok: false, error: "aborted before start" };
    }

    const cwd = resolveProfileDir(userId);
    const argv = [HERMES_BIN, PROFILE_FLAG, profile, ONE_SHOT_FLAG, prompt];
    const startedAt = Date.now();
    log.info("hermes-runner.run.start", { userId, profile, cwd, timeoutMs });

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
