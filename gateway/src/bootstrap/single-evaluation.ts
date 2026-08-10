// Single-EVALUATION guard for the gateway composition root.
//
// WHY THIS EXISTS, AND WHY IT IS NOT single-instance.ts.
//
// `single-instance.ts` answers "is another gateway PROCESS running?". This
// answers a different question that no pid file can: "has this same process
// already evaluated the composition root once?".
//
// `bun --hot` re-evaluates the whole module graph inside ONE process and tears
// nothing down. Every re-evaluation constructs another SystemOrchestratorService
// and arms another health watchdog while every previous one keeps ticking, and
// they then fight: each reaps the other's native children by pid file, each
// respawns, and every survivor reads as `foreign` to whichever supervisor did
// not spawn it. Measured on one process: 4 `gateway-started`, 4
// `health-watch started`, 1 pid; it reached twelve supervisors on another run,
// five of which spawned a whisper-stt child inside 10 ms of each other. It does
// not self-heal — the next reload adds one more.
//
// The dev command is therefore `bun --watch` (a real restart per change), and
// this guard makes the retired command fail LOUDLY instead of silently
// corrupting the machine's addon fleet for the rest of the session. A developer
// or agent who types `bun --hot` from muscle memory gets one legible refusal
// naming the replacement, not a day of chasing symptoms.
//
// WHY THE STAMP LIVES ON `globalThis`, measured rather than assumed:
//
//   mode           OS pid across reloads   `globalThis` across reloads
//   bun --hot      identical               PRESERVED  (eval count 1, 2, 3)
//   bun --watch    identical               RESET      (eval count 1, 1, 1)
//
// The pid is identical under both, so comparing pids cannot see a hot reload at
// all. `globalThis` is the only scope that distinguishes them, which is exactly
// why it is also the scope a leak would survive in.

import { getLog } from "../logging/logger.ts";

const log = getLog(["bootstrap", "single-evaluation"]);

/** Property key of the stamp on the host scope. A `Symbol.for` key is used so
 *  the value is addressable from any evaluation of any module without either
 *  side importing the other — module identity is precisely what a hot reload
 *  destroys. */
export const EVALUATION_STAMP_KEY: unique symbol = Symbol.for("sentient.gateway.compositionRootEvaluated");

/** What the first evaluation left behind for a second one to find. */
export interface EvaluationStamp {
  readonly pid: number;
  /** Wall clock of the first evaluation, so the refusal can report how long the
   *  live process has been up rather than just that it exists. */
  readonly at: number;
}

export type EvaluationClaim = { readonly ok: true } | { readonly ok: false; readonly previous: EvaluationStamp };

function readStamp(scope: Record<PropertyKey, unknown>): EvaluationStamp | null {
  const raw = scope[EVALUATION_STAMP_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const { pid, at } = raw as Partial<EvaluationStamp>;
  if (typeof pid !== "number" || typeof at !== "number") return null;
  return { pid, at };
}

/**
 * Claims this process's one and only composition-root evaluation.
 *
 * Returns `ok: false` with the first evaluation's stamp when the caller is a
 * hot reload — the caller reports it and exits, because there is nothing
 * useful it can do instead: module state is already fresh, so it cannot reuse
 * the live object graph, and constructing a second one is the defect.
 */
export function claimSingleEvaluation(scope: Record<PropertyKey, unknown>, pid: number, now: number): EvaluationClaim {
  const previous = readStamp(scope);
  if (previous !== null) {
    log.error("evaluation.refused", {
      pid,
      firstEvaluatedAt: previous.at,
      reason: "this process already evaluated the composition root — an in-process hot reload, not a restart",
    });
    return { ok: false, previous };
  }
  const stamp: EvaluationStamp = { pid, at: now };
  scope[EVALUATION_STAMP_KEY] = stamp;
  log.debug("evaluation.claimed", { pid, at: now });
  return { ok: true };
}

/** The operator-facing message for a refused re-evaluation. Names the retired
 *  command and the one that replaces it — a bare "already evaluated" leaves the
 *  reader with no idea which of their two dev commands is the problem. */
export function describeHotReloadRefusal(previous: EvaluationStamp, now: number): string {
  const uptimeSec = Math.max(0, Math.round((now - previous.at) / 1000));
  return [
    `this gateway process (pid ${previous.pid}, up ${uptimeSec}s) has already evaluated its composition root.`,
    "That only happens under `bun --hot`, which re-evaluates the module graph inside one process",
    "and tears nothing down: every reload arms another addon supervisor beside the live one, and",
    "they then reap and respawn each other's whisper-stt and local-tts children until no supervisor",
    "owns the ports. Refusing here instead of corrupting the machine's addon fleet.",
    "",
    "  use:  bun run dev            # gateway/package.json -> bun --watch src/main.ts",
    "  not:  bun --hot src/main.ts",
  ].join("\n");
}
