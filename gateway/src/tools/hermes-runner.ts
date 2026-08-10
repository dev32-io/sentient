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
// HOW A FAILURE IS DETECTED, and why it is not the exit code. Measured against
// hermes v0.19.0 on 2026-07-31: a delegation against a stale profile printed
// `HTTP 401: User not found.` on **stdout**, wrote **nothing** to stderr, and
// exited **0**. Three of the four obvious signals therefore carry nothing, and
// the fourth is a trap:
//
//   * exit code — 0 on that failure. Still checked (a non-zero exit is real),
//     but it cannot be the only check.
//   * stderr — empty on that failure.
//   * output LENGTH — the failure was 26 characters and a successful
//     `-z "Reply with the single word: yes"` was **3**. There is no threshold
//     here; "yes" is a legitimate answer and any length rule would reject it.
//   * output SHAPE — matching `HTTP <code>:` is a heuristic over text a model
//     may legitimately quote.
//
// So the runner asks hermes for its own verdict: `--usage-file <path>` writes a
// JSON report whose help text promises it is written "even when the run fails",
// and it carries `completed` / `failed` booleans. That is an explicit error
// CHANNEL rather than an inference over the answer. The file is per-run,
// unguessable, and removed afterwards.
//
// The one honest gap: a hermes too old to know `--usage-file` rejects the flag
// and exits non-zero, so every delegation would fail loudly and legibly
// (`hermes-runner.run.non-zero-exit` naming the usage error) rather than
// silently. A report that is missing or unparseable after a ZERO exit is
// fail-OPEN with a WARN — refusing an answer we have no evidence against is the
// worse error, and the WARN keeps the blind spot visible.
//
// `spawn` is injected (default `Bun.spawn`) so the unit test can supply a
// fake process without ever spawning a real `hermes` binary.

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLog } from "../logging/logger.js";
import type { UserId } from "../user-auth/user-id.js";

const log = getLog(["sentient", "tools", "hermes-runner"]);

const HERMES_BIN = "hermes";
const PROFILE_FLAG = "-p";
const ONE_SHOT_FLAG = "-z";
const USAGE_FILE_FLAG = "--usage-file";
const STDERR_PREVIEW_MAX = 500; // truncate captured stderr/stdout previews in the error message + logs

/** Model-facing text when hermes reports a failed run but printed nothing
 *  usable to explain it. */
const OPAQUE_FAILURE = "the delegated agent reported a failed run with no output";

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

/** The report's verdict. `unknown` means the file was absent or unreadable —
 *  a distinct outcome from "it says the run succeeded", because only one of
 *  those two is evidence. */
type RunVerdict = "succeeded" | "failed" | "unknown";

/** Reads hermes's own `--usage-file` report. Never throws: this is bookkeeping
 *  around a run that has already happened, and a temp-file problem must not turn
 *  a good delegation into a failed one. */
async function readVerdict(usagePath: string, userId: string): Promise<RunVerdict> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(usagePath).text());
    if (parsed === null || typeof parsed !== "object") return "unknown";
    const report = parsed as { failed?: unknown; completed?: unknown };
    if (report.failed === true || report.completed === false) return "failed";
    return report.completed === true ? "succeeded" : "unknown";
  } catch (err) {
    log.warn("hermes-runner.usage-report.unreadable", {
      userId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return "unknown";
  }
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
    // Per-run and unguessable: two concurrent delegations must never read each
    // other's verdict, and a stale file from a killed run must never be mistaken
    // for this one's.
    const usagePath = join(tmpdir(), `sentient-hermes-usage-${crypto.randomUUID()}.json`);
    const argv = [HERMES_BIN, PROFILE_FLAG, profile, USAGE_FILE_FLAG, usagePath, ONE_SHOT_FLAG, prompt];
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

      // Abort and timeout are decided WITHOUT the report: the child was killed,
      // so a missing report says nothing, and warning about it on every barge-in
      // would be noise. Cleanup still happens, in `finally`.
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
      // Exit 0 and hermes still says the run failed — the 401 case. The output
      // is the explanation the user needs, so it is returned as the error text.
      const verdict = await readVerdict(usagePath, userId);
      if (verdict === "failed") {
        const reason = truncate(stdout || stderr) || OPAQUE_FAILURE;
        log.warn("hermes-runner.run.reported-failed", {
          userId,
          code,
          elapsedMs,
          reasonLength: reason.length,
          reason: "hermes exited 0 but its usage report says the run failed",
        });
        return { ok: false, error: reason };
      }
      if (verdict === "unknown") {
        log.warn("hermes-runner.run.verdict-unknown", {
          userId,
          elapsedMs,
          reason: "no readable usage report — treating a zero exit as success, which is the pre-2026-07-31 blind spot",
        });
      }

      log.info("hermes-runner.run.ok", { userId, elapsedMs, verdict, outputLength: stdout.length });
      return { ok: true, output: stdout };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      await unlink(usagePath).catch(() => undefined);
    }
  }

  return { run };
}
