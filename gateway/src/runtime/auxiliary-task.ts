// The AUXILIARY-TASK SEAM (session-model spec §6) — one runner for every
// out-of-band model call that is ABOUT a conversation rather than part of it.
//
// SESSION TITLING IS ITS FIRST USER, NOT ITS SHAPE. Tags, follow-up
// suggestions and summarisation are the spec's named next ones, and each of
// them must be a prompt template plus a caller — a new `.md` file in the
// auxiliary template dir and one function that supplies variables and a zod
// schema. Nothing in this file knows what a title is. Same seam Open WebUI's
// "task model" uses to drive titles, tags and follow-ups from one place.
//
// FOUR PROPERTIES, ALL OF WHICH ARE THE REASON THIS IS A SEAM AND NOT A HELPER:
//
//   1. IT NEVER THROWS, AND RETURNS `null` ON EVERY FAILURE. The caller runs on
//      a turn's DETACHED settle continuation, so a rejection escaping it is a
//      process-level `unhandledRejection` — and Bun answers one by exiting the
//      whole gateway, for every connected user, because one title failed. The
//      caller decides the fallback; this module decides nothing.
//   2. THE INPUT IS BOUNDED HERE, NOT IN EACH CALLER. One shared character
//      budget (`input_truncation_chars`) across every substituted variable.
//      A pasted document in the first message otherwise rides into the prompt
//      whole — the same class of defect as wave 1's tool-result cap, and the
//      same answer: bound it at the seam so every future caller inherits it.
//   3. THE ANSWER IS SCHEMA-VALIDATED. A model that answers in prose, or with
//      a differently-shaped object, fails CLOSED. Structured output is what
//      makes one seam serve tasks whose answers have nothing in common.
//   4. NO TOOLS, EVER. A model call that can act is a side-effecting surface
//      nobody mediates (spec §2.2) — the identical reason compaction.ts sends
//      `tools: []`. Auxiliary tasks are read-only by construction.
//
// The per-request deadline is the ProviderClient's own
// (`orchestrator.provider.request_timeout_ms`); there is no second timeout
// here, because a second one would be a second thing to tune wrong.

import type { OrchestratorConfig } from "@sentient/config";
import type { z } from "zod";
import { getLog } from "../logging/logger.js";
import type { ProviderClient, ProviderStreamChunk } from "../provider/provider-client.js";
import type { ChatMessage } from "../store/model-projection.js";

const log = getLog(["sentient", "runtime", "auxiliary-task"]);

export type AuxiliaryTaskConfig = OrchestratorConfig["auxiliary"];

/** Every way an auxiliary task can fail to produce a validated answer. A
 *  machine-readable vocabulary rather than a message, because the caller logs
 *  it as the ROOT cause next to whatever fallback it chose. */
export type AuxiliaryFailureReason =
  | "template-missing"
  | "aborted"
  | "provider-error"
  | "empty-response"
  | "unparseable-json"
  | "schema-mismatch";

export interface AuxiliaryTaskRequest<T> {
  /** File name inside the auxiliary template dirs, e.g. `"title.md"`.
   *  Resolved by `deps.loadTemplate` through the operator-override loader. */
  readonly templatePath: string;
  /** Substituted into the template's `{{name}}` placeholders. Values share
   *  ONE truncation budget — see `allocateBudget` below. */
  readonly variables: Record<string, string>;
  /** The structured answer. A response that does not satisfy it is a failure,
   *  never a partially-trusted result. */
  readonly schema: z.ZodType<T>;
  /** Per-request output cap. Separate from the config default so a future
   *  task whose answer is genuinely longer (a summary) can say so. */
  readonly maxOutputTokens: number;
}

export interface AuxiliaryTaskDeps {
  readonly provider: ProviderClient;
  readonly config: AuxiliaryTaskConfig;
  /** Operator override → baked-in, already resolved. INJECTED rather than
   *  read from disk here so a test drives this seam with no filesystem, and
   *  so the two-tier lookup lives in exactly one module
   *  (context/system-prompt-loader.ts). `null` = neither file exists. */
  readonly loadTemplate: (templatePath: string) => string | null;
  /** Aborted when the owning session is torn down. Threaded into the provider
   *  call so a disposal cancels the round trip instead of paying for it. */
  readonly signal: AbortSignal;
  /** Which task this is, for the log. Not read for any decision. */
  readonly taskName: string;
  readonly sessionId: string;
  readonly userId: string;
  /**
   * Called once with the machine-readable reason when the task fails.
   *
   * The return type is `T | null` by contract (a caller must not have to
   * destructure a result to find out it has nothing), so this is how a caller
   * carries the ROOT cause into its own fallback log instead of restating
   * "the auxiliary task failed" — which is exactly the vacuous log line that
   * makes a failure undiagnosable in production.
   */
  readonly onFailure?: (reason: AuxiliaryFailureReason) => void;
}

/** Marks where a value was cut, so a truncated prompt is recognisable as one
 *  by whoever reads the log or the model itself. */
const TRUNCATION_MARKER = "…[truncated]";

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * How many characters each variable may contribute, sharing ONE budget.
 *
 * Water-filling, shortest value first: a small variable always fits whole, and
 * whatever is left is split evenly among the ones still too long. Deliberately
 * ORDER-INDEPENDENT — a greedy pass in declaration order would let whichever
 * variable a caller happened to list first eat the entire budget and starve a
 * short one that costs almost nothing, and the caller has no way to know that.
 */
function allocateBudget(values: readonly string[], budget: number): number[] {
  const order = values.map((value, index) => ({ index, length: value.length })).sort((a, b) => a.length - b.length);
  const allowance = new Array<number>(values.length).fill(0);
  let remaining = budget;
  let unfilled = order.length;
  for (const { index, length } of order) {
    const share = Math.floor(remaining / unfilled);
    const granted = Math.min(length, share);
    allowance[index] = granted;
    remaining -= granted;
    unfilled -= 1;
  }
  return allowance;
}

function truncateTo(value: string, allowance: number): string {
  if (value.length <= allowance) return value;
  if (allowance <= TRUNCATION_MARKER.length) return value.slice(0, allowance);
  return value.slice(0, allowance - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * The template with every `{{name}}` replaced by its bounded value.
 *
 * The TEMPLATE ITSELF IS NEVER TRUNCATED. Bounding the rendered prompt instead
 * would hit the same length target while amputating whatever instruction sits
 * at the end of the file — which is where "answer with JSON only" lives.
 *
 * A NAME MISMATCH IS REPORTED, NOT SWALLOWED. An unmatched `{{placeholder}}`
 * renders literally and the model is asked to title a conversation it was
 * never shown; a supplied-but-unused variable silently eats budget from the
 * ones that ARE substituted. Both are pure typos, both survive every test that
 * asserts on the answer, and every future caller of this seam inherits the
 * silence — so the mismatch is named in the log rather than left for someone
 * to notice in a prompt dump. DEBUG, not WARN: it is a template-authoring
 * signal, not a degraded path, and the e2e gate reads WARNs as failures.
 */
export function renderAuxiliaryPrompt(
  template: string,
  variables: Record<string, string>,
  budget: number,
  onNameMismatch?: (unmatched: string[], unused: string[]) => void,
): string {
  const names = Object.keys(variables);
  const allowance = allocateBudget(
    names.map((name) => variables[name] ?? ""),
    budget,
  );
  const bounded = new Map<string, string>();
  names.forEach((name, index) => bounded.set(name, truncateTo(variables[name] ?? "", allowance[index] ?? 0)));

  const seen = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (whole, name: string) => {
    seen.add(name);
    return bounded.get(name) ?? whole;
  });

  if (onNameMismatch !== undefined) {
    const unmatched = [...seen].filter((name) => !bounded.has(name));
    const unused = names.filter((name) => !seen.has(name));
    if (unmatched.length > 0 || unused.length > 0) onNameMismatch(unmatched, unused);
  }
  return rendered;
}

/**
 * The JSON object inside a model response, or null.
 *
 * Models wrap structured answers in ``` fences and in leading prose no matter
 * what the prompt says, so the first `{` through the last `}` is the pragmatic
 * extraction. Refusing anything that isn't already bare JSON would fail closed
 * on a response that is, in fact, perfectly usable.
 */
function extractJson(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** One provider round trip, collected as text. Null on any provider failure —
 *  never a throw (see this file's property 1). */
async function collectAnswer<T>(
  req: AuxiliaryTaskRequest<T>,
  deps: AuxiliaryTaskDeps,
  prompt: string,
): Promise<string | null> {
  // ONE user message, no system message: the template IS the whole
  // instruction, and a fixed system preamble here would be exactly the inline
  // prompt string the clean-code rule keeps out of source.
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  // `stream(...)` is INSIDE the try, not before it. A `ProviderClient` whose
  // stream is an async generator cannot throw here, but one that resolves a
  // client per call (user-model-provider.ts) can — and a throw outside the try
  // escapes this "never throws" seam into a detached continuation.
  let stream: AsyncGenerator<ProviderStreamChunk> | null = null;
  let answer = "";
  try {
    stream = deps.provider.stream({
      messages,
      tools: [],
      signal: deps.signal,
      maxOutputTokens: req.maxOutputTokens,
      reasoningEffort: deps.config.reasoning_effort,
    });
    for await (const chunk of stream) {
      if (deps.signal.aborted) break;
      if (chunk.type === "text") answer += chunk.content;
    }
  } catch (err) {
    log.warn("auxiliary-task.provider-failed", {
      userId: deps.userId,
      sessionId: deps.sessionId,
      taskName: deps.taskName,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    // A throw from the `finally` is NOT caught by its own try's catch — it
    // replaces whatever the block was doing and escapes this "never throws"
    // seam into the caller's detached continuation, where Bun exits the
    // process on the unhandled rejection. A generator whose cleanup path
    // throws is unusual but entirely expressible, and nothing else here would
    // stop it.
    try {
      await stream?.return(undefined);
    } catch (err) {
      log.warn("auxiliary-task.stream-cleanup-failed", {
        userId: deps.userId,
        sessionId: deps.sessionId,
        taskName: deps.taskName,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return answer;
}

/**
 * Run one auxiliary task. Resolves with the validated answer, or `null` when
 * anything at all went wrong — see this file's header for why that is a
 * contract and not laziness.
 */
export async function runAuxiliaryTask<T>(req: AuxiliaryTaskRequest<T>, deps: AuxiliaryTaskDeps): Promise<T | null> {
  const { userId, sessionId, taskName } = deps;

  function fail(reason: AuxiliaryFailureReason, detail: Record<string, unknown> = {}): null {
    log.warn("auxiliary-task.failed", { userId, sessionId, taskName, reason, ...detail });
    deps.onFailure?.(reason);
    return null;
  }

  const template = deps.loadTemplate(req.templatePath);
  if (template === null) return fail("template-missing", { templatePath: req.templatePath });
  if (deps.signal.aborted) return fail("aborted");

  const prompt = renderAuxiliaryPrompt(
    template,
    req.variables,
    deps.config.input_truncation_chars,
    (unmatched, unused) => {
      log.debug("auxiliary-task.template-variable-mismatch", {
        userId,
        sessionId,
        taskName,
        templatePath: req.templatePath,
        // NAMES only — a variable's VALUE is conversation content.
        unmatchedPlaceholders: unmatched.join(","),
        unusedVariables: unused.join(","),
        reason: "template placeholders and supplied variables do not line up — check the .md against its caller",
      });
    },
  );
  const startedAt = Date.now();
  log.debug("auxiliary-task.start", {
    userId,
    sessionId,
    taskName,
    promptChars: prompt.length,
    truncationBudget: deps.config.input_truncation_chars,
    maxOutputTokens: req.maxOutputTokens,
    reasoningEffort: deps.config.reasoning_effort,
  });

  const answer = await collectAnswer(req, deps, prompt);
  if (answer === null) return fail("provider-error");
  if (deps.signal.aborted) return fail("aborted");
  if (answer.trim().length === 0) return fail("empty-response");

  const json = extractJson(answer);
  if (json === null) return fail("unparseable-json", { answerChars: answer.length });

  const parsed = req.schema.safeParse(json);
  if (!parsed.success) return fail("schema-mismatch", { issue: parsed.error.issues[0]?.message ?? "unknown" });

  log.info("auxiliary-task.done", {
    userId,
    sessionId,
    taskName,
    durationMs: Date.now() - startedAt,
    answerChars: answer.length,
  });
  return parsed.data;
}
