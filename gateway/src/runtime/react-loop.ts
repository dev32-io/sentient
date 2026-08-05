// The native ReAct loop (spec §4.3, Plan 2 Task 6) — the spine of the agent.
//
// Re-reads the store's model projection at the TOP of every iteration. That
// re-read — not any special-cased "steer" branch — IS the entire steer
// mechanism (spec §4.5): a stimulus appended to the store mid-flight (a
// background-task completion today; a future ambient/mid-turn signal) is
// picked up automatically on the next iteration because the loop never
// carries a cached `messages[]` across iterations. Never hoist the
// `projectForModel(store.readSession(...))` call out of the `while`.
//
// Prior-art lessons carried forward (do not regress):
//  - `tools[]` is computed ONCE from `broker.definitions()` and passed
//    unchanged every iteration — an immutable tool set is both a caching
//    property and a security property (spec §4.6); mutating it per-turn is
//    the bug this loop must never reintroduce.
//  - The model MUST see its own tool result. A foreground dispatch appends
//    BOTH `tool_call` and `tool_result`; skip the result and the model
//    re-issues the same call next iteration (the pre-Hermes 3x-refire bug).
//  - Text is never smuggled through as a tool. Assistant text streams from
//    provider `text` chunks straight to `onTextDelta`; on the FINAL response
//    (no tool_calls, or the forced-final iteration) it is committed as the
//    terminal `assistant` entry — matching spec §4.3's flowchart. Narration
//    that precedes a tool call in the SAME iteration (content AND tool_calls
//    in one assistant message — Qwen/DeepSeek/GLM/many OpenRouter routes do
//    this; multi-iteration ReAct narration hits this on every acting
//    non-final iteration) is committed as its OWN standalone `assistant`
//    entry BEFORE that iteration's `tool_call` entries — a `tool_call` entry
//    has no text field to carry it, and model-projection.ts's block-adjacency
//    pairing was never designed to merge assistant content with a
//    `tool_calls` array. Committing it as a preceding entry instead keeps
//    live and replay converged (spec §3.2 Invariant B: `render(replay) ==
//    render(live)`) — text is committed exactly once per iteration, either
//    as this standalone narration entry or as the terminal assistant entry,
//    never both.
//  - `max_iterations` bounds the loop; the FINAL allowed iteration is forced
//    content-only (`tools: []`) so budget exhaustion always yields a reply,
//    never silence.
//  - AbortSignal is checked at every yield point (top of iteration, after
//    the stream settles, before each tool dispatch). On abort: stop
//    consuming, stop dispatching, append NOTHING further, return without
//    throwing. Stamping a cutoff kind onto the partial output belongs to a
//    layer above this one (Task 8) — this loop's contract stops at "don't
//    throw, don't partially commit."

import type { OrchestratorConfig } from "@sentient/config";
import type { TimeZoneProvider } from "../context/message-time.js";
import { getLog } from "../logging/logger.js";
import type { ProviderClient, ProviderTool } from "../provider/provider-client.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import type { ChatMessage, ChatToolCall } from "../store/model-projection.js";
import { projectForModel } from "../store/model-projection.js";
import type { SessionStore } from "../store/session-store.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition, ToolInvocation } from "../tools/tool-types.js";

const log = getLog(["sentient", "runtime", "react-loop"]);

const DEBUG_PREVIEW_LEN = 120;

/** Client-facing tool-tile preview budget (spec §7 `turn.tool.update`).
 *  Separate from DEBUG_PREVIEW_LEN: this one ships to a UI, not a log. */
const ARGS_PREVIEW_LEN = 120;

export type ToolUpdateStatus = "running" | "done" | "error";

/** Fed to `onToolUpdate` for the client's running/done tool tiles (spec §7).
 *  `taskId` is present only on a background dispatch's single "running"
 *  update — its eventual completion arrives later as a stimulus (Task 7),
 *  never as a second update through this callback. */
export interface ToolUpdate {
  toolCallId: string;
  toolName: string;
  status: ToolUpdateStatus;
  taskId?: string;
  /** Truncated preview of the raw argument JSON for the client's tool tile.
   *  Optional so existing callers/fakes stay valid; the WS emitter falls back
   *  to "" when absent. */
  argsPreview?: string;
}

export interface ReactLoopDeps {
  provider: ProviderClient;
  broker: ToolBroker;
  store: SessionStore;
  systemPrompt: string;
  /** Zone for every message stamp — see context/message-time.ts. */
  timeZone: TimeZoneProvider;
  /** Prompt tier 3: per-session, static, emitted straight after the system
   *  prompt. Memoized by the caller — see session-runtime.ts. */
  sessionBlock?: () => Promise<string | null>;
  /** Prompt tier 5: volatile, re-read per turn, emitted LAST so nothing
   *  downstream of it can be invalidated by it. */
  situationBlock?: () => Promise<string | null>;
  sessionId: string;
  config: OrchestratorConfig["loop"];
  onTextDelta: (turnId: string, text: string) => void;
  onToolUpdate: (turnId: string, u: ToolUpdate) => void;
  /** Fired synchronously, immediately after the terminal assistant entry is
   *  appended to the store (natural completion — no-toolcalls or
   *  forced-final iteration). A pure durability notification, same category
   *  as `onToolUpdate`: it tells the caller "this turn's final text is now
   *  in the store," nothing more. Does NOT reopen this loop's "don't stamp
   *  cutoff" contract — this loop still never touches `cutoff` itself. */
  onTurnCommitting?: (turnId: string) => void;
}

export interface RunTurnArgs {
  turnId: string;
  signal: AbortSignal;
}

function toProviderTool(def: ToolDefinition): ProviderTool {
  return {
    type: "function",
    function: { name: def.name, description: def.description, parameters: def.parameters },
  };
}

function parseToolArgs(raw: string, toolName: string, toolCallId: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    log.warn("react-loop.tool-args.not-an-object", {
      toolName,
      toolCallId,
      rawPreview: raw.slice(0, DEBUG_PREVIEW_LEN),
    });
    return {};
  } catch (err) {
    log.warn("react-loop.tool-args.parse-failed", {
      toolName,
      toolCallId,
      reason: err instanceof Error ? err.message : String(err),
      rawPreview: raw.slice(0, DEBUG_PREVIEW_LEN),
    });
    return {};
  }
}

/** The common, mostly-null entry shape every kind starts from — keeps each
 *  call site down to only the fields that kind actually carries. */
function blankEntry(sessionId: string, turnId: string): Omit<NewSessionEntry, "kind"> {
  return {
    sessionId,
    turnId,
    createdAt: Date.now(),
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  };
}

/** Longest a background receipt may be. The stored `tool_result` is NOT
 *  model-only text: `client-projection.ts` folds it into the tool tile as
 *  `summary` and the webui renders it as `resultPreview`, truncated at 120
 *  (webui/hooks/cycle-helpers.ts). A receipt over the cap gets cut mid-sentence
 *  in the user's transcript. Not config — it mirrors a UI constant. */
const BACKGROUND_RECEIPT_MAX = 120;

/** The `tool_result` text a background dispatch is answered with.
 *
 *  Deliberately a plain FACT about the task, with no instruction to the model in
 *  it. Two reasons: a family member reads this string in their transcript after
 *  a reload, and the thing that actually stops the refire is not wording — it is
 *  that this entry EXISTS (so the projection stops dropping the call) plus the
 *  per-turn guard, neither of which depends on model compliance. */
function backgroundDispatchedText(taskId: string): string {
  return `Dispatched in the background (taskId=${taskId}). Its result will arrive separately.`;
}

/** Same, for a repeat the per-turn guard refused to dispatch a second time. */
function backgroundAlreadyRunningText(taskId: string): string {
  return `Already running in the background (taskId=${taskId}). Not started again.`;
}

/** Per-turn identity of a background dispatch: same tool, same arguments. */
function dispatchKey(toolName: string, rawArgs: string): string {
  return `${toolName}::${rawArgs}`;
}

interface BackgroundReceipt {
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  taskId: string;
  text: string;
}

/** Answer a background `tool_call` and keep the client tile in the running
 *  state — the tile settles when the completion stimulus lands, not here. */
function appendBackgroundReceipt(
  deps: Pick<ReactLoopDeps, "store" | "onToolUpdate">,
  sessionId: string,
  turnId: string,
  receipt: BackgroundReceipt,
): void {
  const { toolCallId, toolName, argsPreview, taskId } = receipt;
  const text = receipt.text.slice(0, BACKGROUND_RECEIPT_MAX);
  deps.store.append({
    ...blankEntry(sessionId, turnId),
    kind: "tool_result",
    toolCallId,
    toolName,
    toolArgs: text,
  });
  deps.onToolUpdate(turnId, { toolCallId, toolName, status: "running", taskId, argsPreview });
}

/**
 * Runs every tool call the model requested this iteration, in order.
 *
 * Every call — foreground or background — appends `tool_call` + `tool_result`.
 * The complete round-trip is not optional for the background branch either:
 * `projectForModel` pairs a tool_call only with the immediately-following run of
 * tool_results and DROPS anything unreplied, so a background dispatch that
 * appended a bare `system` note erased the model's own action from the next
 * iteration's messages and it re-issued the call every time (defect D7 — one
 * user request, ten real hermes subprocesses). A background `tool_result` is
 * the dispatch receipt, never the task's output: the output arrives later as its
 * own stimulus, appended as a `trigger` entry, never as a second tool_result for
 * an already-answered id (see model-projection.ts rule 4).
 *
 * `backgroundByKey` carries (toolName, args) → taskId across the ITERATIONS of
 * one turn, so a model that ignores the receipt still cannot start the same task
 * twice. Model-independent by design: a prompt-only fix depends on compliance.
 *
 * Returns `false` the instant the signal aborts: stops before starting the
 * next call, appends nothing further, and the caller must stop looping.
 */
async function dispatchToolCalls(
  deps: Pick<ReactLoopDeps, "broker" | "store" | "onToolUpdate">,
  sessionId: string,
  turnId: string,
  signal: AbortSignal,
  toolCalls: ChatToolCall[],
  backgroundByKey: Map<string, string>,
): Promise<boolean> {
  const { broker, store, onToolUpdate } = deps;

  for (const call of toolCalls) {
    if (signal.aborted) {
      log.info("react-loop.tool-dispatch.aborted", { sessionId, turnId, toolCallId: call.id });
      return false;
    }

    const toolCallId = call.id;
    const toolName = call.function.name;
    const argsPreview = call.function.arguments.slice(0, ARGS_PREVIEW_LEN);

    store.append({
      ...blankEntry(sessionId, turnId),
      kind: "tool_call",
      toolCallId,
      toolName,
      toolArgs: call.function.arguments,
    });
    onToolUpdate(turnId, { toolCallId, toolName, status: "running", argsPreview });

    const key = dispatchKey(toolName, call.function.arguments);
    const runningTaskId = backgroundByKey.get(key);
    if (runningTaskId !== undefined) {
      appendBackgroundReceipt(deps, sessionId, turnId, {
        toolCallId,
        toolName,
        argsPreview,
        taskId: runningTaskId,
        text: backgroundAlreadyRunningText(runningTaskId),
      });
      log.warn("react-loop.tool-dispatch.background-duplicate-refused", {
        sessionId,
        turnId,
        toolCallId,
        toolName,
        taskId: runningTaskId,
        reason: "an identical background call is already running for this turn",
      });
      continue;
    }

    const args = parseToolArgs(call.function.arguments, toolName, toolCallId);
    const invocation: ToolInvocation = { toolCallId, name: toolName, args, signal, turnId };
    const outcome = await broker.dispatch(invocation);

    if (signal.aborted) {
      log.info("react-loop.tool-dispatch.aborted-post-call", { sessionId, turnId, toolCallId });
      return false;
    }

    if ("taskId" in outcome) {
      backgroundByKey.set(key, outcome.taskId);
      appendBackgroundReceipt(deps, sessionId, turnId, {
        toolCallId,
        toolName,
        argsPreview,
        taskId: outcome.taskId,
        text: backgroundDispatchedText(outcome.taskId),
      });
      log.info("react-loop.tool-dispatch.background", {
        sessionId,
        turnId,
        toolCallId,
        toolName,
        taskId: outcome.taskId,
      });
      continue;
    }

    store.append({
      ...blankEntry(sessionId, turnId),
      kind: "tool_result",
      toolCallId,
      toolName,
      toolArgs: outcome.content,
    });
    onToolUpdate(turnId, { toolCallId, toolName, status: outcome.isError ? "error" : "done", argsPreview });
    log.info("react-loop.tool-dispatch.foreground", {
      sessionId,
      turnId,
      toolCallId,
      toolName,
      isError: outcome.isError,
      resultLength: outcome.content.length,
    });
  }

  return true;
}

interface StreamOutcome {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: string;
  aborted: boolean;
  cacheHitRatio?: number;
}

/** Consumes one provider stream to completion (or abort), forking text
 *  deltas out live and accumulating tool calls. Always releases the
 *  generator on the way out (bun-typescript rule: always `.return()` a
 *  streaming operation on cleanup), whether it ran to exhaustion or was
 *  broken out of early. */
async function consumeStream(
  provider: ProviderClient,
  messages: ChatMessage[],
  tools: ProviderTool[],
  signal: AbortSignal,
  onTextDelta: (text: string) => void,
): Promise<StreamOutcome> {
  const stream = provider.stream({ messages, tools, signal });
  let text = "";
  const toolCalls: ChatToolCall[] = [];
  let finishReason = "";
  let usage: { promptTokens: number; cachedTokens: number; completionTokens: number } | undefined;

  try {
    for await (const chunk of stream) {
      if (signal.aborted) break;
      if (chunk.type === "text") {
        text += chunk.content;
        onTextDelta(chunk.content);
        log.debug("react-loop.stream.chunk.text", { length: chunk.content.length });
      } else if (chunk.type === "tool_call") {
        toolCalls.push(chunk.toolCall);
        log.debug("react-loop.stream.chunk.tool-call", {
          toolCallId: chunk.toolCall.id,
          toolName: chunk.toolCall.function.name,
        });
      } else if (chunk.type === "done") {
        finishReason = chunk.finishReason;
        usage = chunk.usage;
      }
    }
  } finally {
    await stream.return(undefined);
  }

  const cacheHitRatio = usage && usage.promptTokens > 0 ? usage.cachedTokens / usage.promptTokens : undefined;

  return {
    text,
    toolCalls,
    finishReason,
    aborted: signal.aborted,
    ...(cacheHitRatio !== undefined ? { cacheHitRatio } : {}),
  };
}

export interface TurnOutcome {
  completed: boolean;
  iterations: number;
  /** Store tail seq as of the LAST iteration's `readSession` — i.e. the
   *  high-water mark this turn's final provider request actually included.
   *
   *  This is what makes a mid-loop steer single-shot. `SessionRuntime` used to
   *  decide "is a back-to-back follow-up turn owed?" against a snapshot taken
   *  at turn START, so any entry a steer appended mid-turn stayed "unprocessed"
   *  for the rest of the turn's life and fired a second, empty turn even though
   *  an iteration had already folded it in. Reporting what was really consumed
   *  keeps spec §4.5's genuine case intact — a stimulus landing AFTER this seq
   *  was never seen by the loop and still owes a new turn. */
  consumedThroughSeq: number;
}

/** A paragraph break. Two newlines, because one is a soft wrap in Markdown and
 *  would still render the next segment as the same paragraph. */
const SEGMENT_BREAK = "\n\n";

/**
 * What must be appended to [text] so the segment is properly terminated —
 * "" when it already is.
 *
 * A suffix rather than a rewrite: the text has already been streamed to the
 * client verbatim, so anything but an append would make the live bubble and the
 * committed entry disagree.
 */
function segmentTerminator(text: string): string {
  if (text.endsWith(SEGMENT_BREAK)) return "";
  return text.endsWith("\n") ? "\n" : SEGMENT_BREAK;
}

export async function runTurn(deps: ReactLoopDeps, args: RunTurnArgs): Promise<TurnOutcome> {
  const {
    provider,
    broker,
    store,
    systemPrompt,
    timeZone,
    sessionBlock,
    situationBlock,
    sessionId,
    config,
    onTextDelta,
    onTurnCommitting,
  } = deps;
  const { turnId, signal } = args;

  // Immutable per spec §4.6 — computed once, passed unchanged every
  // iteration below. Never re-derived or mutated inside the loop.
  //
  // Awaited first: the MCP half of the vocabulary is I/O and lands ~100ms after
  // a session binds, while the first turn of a fresh session starts in the same
  // tick as `session.configure`. Without this the first turn of every session
  // went to the provider with `delegateTask` as its ONLY tool — and a model
  // holding one tool uses it. Memoized in the broker, so this is free from the
  // second turn on. See `ToolBroker.ready`.
  await broker.ready();
  const tools = broker.definitions().map(toProviderTool);
  const maxIterations = config.max_iterations;

  // (toolName, args) -> taskId for background dispatches made by THIS turn.
  // Turn-scoped on purpose: a later turn asking for the same delegation is a
  // new user intent and must be allowed; the same iteration-loop asking twice
  // is the D7 refire. Dropped with the turn, so nothing accumulates.
  const backgroundByKey = new Map<string, string>();

  log.info("react-loop.start", { sessionId, turnId, maxIterations, toolCount: tools.length });

  let iteration = 0;
  let consumedThroughSeq = 0;
  while (iteration < maxIterations) {
    iteration += 1;

    if (signal.aborted) {
      log.info("react-loop.aborted-before-iteration", { sessionId, turnId, iteration });
      return { completed: false, iterations: iteration - 1, consumedThroughSeq };
    }

    const forceFinal = iteration === maxIterations;
    // The re-read that makes steer free (spec §4.5): every iteration
    // rebuilds messages[] from the store, never from a cached prior value.
    const entries = store.readSession(sessionId);
    // Recorded BEFORE the provider call, from the same read the request is
    // built from, so it can never claim to have consumed an entry that landed
    // during the stream.
    consumedThroughSeq = entries[entries.length - 1]?.seq ?? consumedThroughSeq;
    // The prompt is a cache cascade, static to volatile: the shared system
    // prompt, then this session's fixed facts, then the stamped history, then
    // whatever is true only right now. Each tier invalidates only what follows
    // it, which is why the volatile block is LAST — anywhere earlier and every
    // turn would break the cached prefix. See context/session-block.ts.
    const [sessionText, situationText] = await Promise.all([sessionBlock?.() ?? null, situationBlock?.() ?? null]);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(sessionText === null ? [] : [{ role: "system" as const, content: sessionText }]),
      ...projectForModel(entries, { timeZone: timeZone.zone() }),
      ...(situationText === null ? [] : [{ role: "system" as const, content: situationText }]),
    ];

    log.debug("react-loop.iteration.start", {
      sessionId,
      turnId,
      iteration,
      forceFinal,
      messageCount: messages.length,
    });

    const outcome = await consumeStream(provider, messages, forceFinal ? [] : tools, signal, (text) =>
      onTextDelta(turnId, text),
    );

    if (outcome.aborted) {
      log.info("react-loop.aborted-mid-stream", { sessionId, turnId, iteration });
      return { completed: false, iterations: iteration, consumedThroughSeq };
    }

    log.info("react-loop.iteration.stream-done", {
      sessionId,
      turnId,
      iteration,
      forceFinal,
      finishReason: outcome.finishReason,
      toolCallCount: outcome.toolCalls.length,
      textLength: outcome.text.length,
      ...(outcome.cacheHitRatio !== undefined ? { cacheHitRatio: Number(outcome.cacheHitRatio.toFixed(3)) } : {}),
    });

    if (forceFinal || outcome.toolCalls.length === 0) {
      // D17 (task 18): a reasoning model can spend its ENTIRE output budget
      // on the invisible reasoning channel and never reach a visible token —
      // finish_reason:"length" with zero text. Committing that as a
      // completed turn is the defect: the record reads `completed=true
      // failed=false` forever, nothing retries, nothing warns, and no
      // oracle built on the turn record can ever see it (live 2/2 via an
      // 81KB ha_get_history result). An empty assistant entry must never be
      // committed as a completed turn, so this returns `completed: false`
      // instead — the EXISTING "turn produced no answer" path
      // (session-runtime.ts's `commitTurnFailure`, already the terminus for
      // a provider error or a timed-out turn) durably commits a
      // user-visible failure notice and still ends the turn cleanly. No
      // retry: there may be no tool call in THIS request to blame, and a
      // retry against a model that just exhausted its budget on the same
      // messages risks looping.
      //
      // The guard is on TEXT, not on `finishReason === "length"` — D17's own
      // closing line is unconditional ("an empty assistant entry must never
      // be committed as a completed turn"). `finishReason` is a free-form
      // `string` off the wire (provider-client.ts), so a provider that
      // returns empty/whitespace-only text under `"stop"`,
      // `"content_filter"`, or any other reason would otherwise fall through
      // and reproduce the exact defect via a different trigger.
      // `finishReason` is still logged below — it's the "why", worth keeping
      // in the diagnostics even though it must not gate the behaviour.
      if (outcome.text.trim().length === 0) {
        log.warn("react-loop.completed-empty-final", {
          sessionId,
          turnId,
          iteration,
          forceFinal,
          finishReason: outcome.finishReason,
          reason:
            "final completion produced no visible text — not committing an empty reply, regardless of finishReason",
        });
        return { completed: false, iterations: iteration, consumedThroughSeq };
      }

      store.append({ ...blankEntry(sessionId, turnId), kind: "assistant", text: outcome.text });
      onTurnCommitting?.(turnId);
      log.info("react-loop.completed", { sessionId, turnId, iterations: iteration, forceFinal });
      return { completed: true, iterations: iteration, consumedThroughSeq };
    }

    // Narration that precedes a tool call in the SAME iteration (many
    // OpenAI-compatible providers — Qwen/DeepSeek/GLM/many OpenRouter routes
    // — emit content AND tool_calls in one assistant message; multi-iteration
    // ReAct narration hits this on every non-final iteration that also acts).
    // It already streamed live via onTextDelta above — commit it as a
    // standalone assistant entry BEFORE the tool_call entries so replay
    // converges with what the live stream showed (spec §3.2 Invariant B).
    // Appended here, never at the terminal branch above, so text is
    // committed exactly once per iteration.
    if (outcome.text.length > 0) {
      // TERMINATED, because more text is coming. This segment is followed by a
      // tool round trip and then, on a later iteration, the rest of the reply —
      // and both halves land in ONE bubble on the client, which appends deltas
      // to a single per-turn buffer. Committed unterminated, the final answer
      // ran straight into the end of the narration with no break at all:
      // "Let me look that up.The news today is…".
      //
      // The terminator is streamed as well as stored, and is a pure SUFFIX of
      // what was already sent, so the live buffer and the replayed entry stay
      // byte-identical (spec §3.2 Invariant B). Terminating in the gateway is
      // the point: it owns what a well-formed segment is, so no client has to
      // reimplement a joining rule and no two clients can disagree about it.
      const suffix = segmentTerminator(outcome.text);
      if (suffix.length > 0) onTextDelta(turnId, suffix);
      store.append({ ...blankEntry(sessionId, turnId), kind: "assistant", text: outcome.text + suffix });
    }

    const dispatchedAll = await dispatchToolCalls(deps, sessionId, turnId, signal, outcome.toolCalls, backgroundByKey);
    if (!dispatchedAll) {
      log.info("react-loop.aborted-mid-dispatch", { sessionId, turnId, iteration });
      return { completed: false, iterations: iteration, consumedThroughSeq };
    }
    // → goto 1: loop back to the top, re-reading the store fresh.
  }

  // Unreachable in practice — the forceFinal branch above always fires (and
  // returns) on iteration === maxIterations, and the config schema's
  // `.min(1)` forbids maxIterations from ever being 0. Kept as a typed,
  // logged fallback rather than an unprovable-to-the-compiler implicit
  // `undefined` return.
  log.warn("react-loop.exhausted-without-final", { sessionId, turnId, iterations: iteration });
  return { completed: false, iterations: iteration, consumedThroughSeq };
}
