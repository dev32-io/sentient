// One place that runs the `hermes` CLI as a subprocess.
//
// Every gateway↔Hermes configuration call goes through Hermes's PUBLIC CLI —
// never a write into `~/.hermes/**`, never a read of a Hermes credential. That
// is the standing "no Hermes internals from the adapter" rule and also the
// smallest possible secret-handling surface: the operator's own profile stays
// the single place a key lives.

import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "external-tools", "hermes-cli"]);

export const HERMES_BIN = "hermes";

/**
 * Truncate captured CLI output before it reaches a log line or an error. 120 is
 * the project-wide preview cap (`.claude/rules/logging.md`).
 *
 * Truncation is NOT the control that protects a credential and must not be
 * mistaken for one: it bounds VOLUME, and a key at char 10 survives any cap.
 * The content control is `logging/log-sanitizer.ts`. Both apply: the sanitizer
 * removes the secret, the cap keeps a multi-KB config dump out of the log file.
 */
const OUTPUT_PREVIEW_MAX = 120;

/** The subset of a spawned process this module touches — narrowed so unit
 *  tests never spawn a real `hermes`. Mirrors `tools/hermes-runner.ts`. */
export interface CliProcess {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | string;
  readonly stderr: ReadableStream<Uint8Array> | string;
  kill(): void;
}

export interface CliSpawnOptions {
  readonly stdout: "pipe";
  readonly stderr: "pipe";
  /** Bytes fed to the child's stdin. `hermes mcp add` asks an interactive
   *  "Enable all N tools?" question; with no answer it cancels (fail-closed). */
  readonly stdin?: Uint8Array;
}

export type CliSpawnFn = (argv: readonly string[], options: CliSpawnOptions) => CliProcess;

export const defaultCliSpawn: CliSpawnFn = (argv, options) =>
  Bun.spawn([...argv], options as never) as unknown as CliProcess;

export type CliError = "spawn-failed" | "timeout" | "non-zero-exit";

export interface CliOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliInput {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** Injected in tests so no unit test spawns a real `hermes`. */
  readonly spawn?: CliSpawnFn;
  /** Answer to the CLI's interactive prompts, if it has any. */
  readonly stdin?: string;
  /** Log-only label so a caller's step is identifiable in the log trail. */
  readonly step: string;
  /** Log-only, for request tracing. */
  readonly userId: string;
}

export function truncate(text: string): string {
  return text.length > OUTPUT_PREVIEW_MAX ? `${text.slice(0, OUTPUT_PREVIEW_MAX)}…` : text;
}

/**
 * Run one hermes CLI invocation to completion. Never throws: a spawn failure,
 * a timeout and a non-zero exit all come back as typed errors the caller logs.
 */
export async function runHermesCli(input: RunCliInput): Promise<Result<CliOutput, CliError>> {
  const { argv, timeoutMs, step, userId } = input;
  const spawn = input.spawn ?? defaultCliSpawn;
  const startedAt = Date.now();

  let proc: CliProcess;
  try {
    proc = spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      ...(input.stdin === undefined ? {} : { stdin: new TextEncoder().encode(input.stdin) }),
    });
  } catch (err: unknown) {
    log.warn("hermes-cli.spawn-failed", {
      step,
      userId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "spawn-failed" };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log.warn("hermes-cli.timeout", { step, userId, timeoutMs });
    proc.kill();
  }, timeoutMs);

  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const elapsedMs = Date.now() - startedAt;
    if (timedOut) return { ok: false, error: "timeout" };
    if (code !== 0) {
      // Preview only, never the whole output: hermes prints a profile's
      // resolved config, which is exactly where a credential would show up.
      log.warn("hermes-cli.non-zero-exit", { step, userId, code, elapsedMs, preview: truncate(stderr || stdout) });
      return { ok: false, error: "non-zero-exit" };
    }
    log.debug("hermes-cli.ok", { step, userId, elapsedMs });
    return { ok: true, value: { stdout, stderr } };
  } finally {
    clearTimeout(timer);
  }
}
