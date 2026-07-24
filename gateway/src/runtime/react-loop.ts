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
}

export interface ReactLoopDeps {
  provider: ProviderClient;
  broker: ToolBroker;
  store: SessionStore;
  systemPrompt: string;
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
  };
}

/**
 * Runs every tool call the model requested this iteration, in order.
 * Foreground calls append `tool_call` + `tool_result` (the full round-trip
 * the model needs to see, spec §5.2). Background calls append `tool_call` +
 * a `system` "task started" note — the eventual result is a later stimulus
 * (Task 7's job), never a second entry through this function.
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
): Promise<boolean> {
  const { broker, store, onToolUpdate } = deps;

  for (const call of toolCalls) {
    if (signal.aborted) {
      log.info("react-loop.tool-dispatch.aborted", { sessionId, turnId, toolCallId: call.id });
      return false;
    }

    const toolCallId = call.id;
    const toolName = call.function.name;

    store.append({
      ...blankEntry(sessionId, turnId),
      kind: "tool_call",
      toolCallId,
      toolName,
      toolArgs: call.function.arguments,
    });
    onToolUpdate(turnId, { toolCallId, toolName, status: "running" });

    const args = parseToolArgs(call.function.arguments, toolName, toolCallId);
    const invocation: ToolInvocation = { toolCallId, name: toolName, args, signal };
    const outcome = await broker.dispatch(invocation);

    if (signal.aborted) {
      log.info("react-loop.tool-dispatch.aborted-post-call", { sessionId, turnId, toolCallId });
      return false;
    }

    if ("taskId" in outcome) {
      store.append({
        ...blankEntry(sessionId, turnId),
        kind: "system",
        text: `Task started: ${toolName} (taskId=${outcome.taskId})`,
      });
      onToolUpdate(turnId, { toolCallId, toolName, status: "running", taskId: outcome.taskId });
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
    onToolUpdate(turnId, { toolCallId, toolName, status: outcome.isError ? "error" : "done" });
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

export async function runTurn(
  deps: ReactLoopDeps,
  args: RunTurnArgs,
): Promise<{ completed: boolean; iterations: number }> {
  const { provider, broker, store, systemPrompt, sessionId, config, onTextDelta, onTurnCommitting } = deps;
  const { turnId, signal } = args;

  // Immutable per spec §4.6 — computed once, passed unchanged every
  // iteration below. Never re-derived or mutated inside the loop.
  const tools = broker.definitions().map(toProviderTool);
  const maxIterations = config.max_iterations;

  log.info("react-loop.start", { sessionId, turnId, maxIterations, toolCount: tools.length });

  let iteration = 0;
  while (iteration < maxIterations) {
    iteration += 1;

    if (signal.aborted) {
      log.info("react-loop.aborted-before-iteration", { sessionId, turnId, iteration });
      return { completed: false, iterations: iteration - 1 };
    }

    const forceFinal = iteration === maxIterations;
    // The re-read that makes steer free (spec §4.5): every iteration
    // rebuilds messages[] from the store, never from a cached prior value.
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...projectForModel(store.readSession(sessionId)),
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
      return { completed: false, iterations: iteration };
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
      store.append({ ...blankEntry(sessionId, turnId), kind: "assistant", text: outcome.text });
      onTurnCommitting?.(turnId);
      log.info("react-loop.completed", { sessionId, turnId, iterations: iteration, forceFinal });
      return { completed: true, iterations: iteration };
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
      store.append({ ...blankEntry(sessionId, turnId), kind: "assistant", text: outcome.text });
    }

    const dispatchedAll = await dispatchToolCalls(deps, sessionId, turnId, signal, outcome.toolCalls);
    if (!dispatchedAll) {
      log.info("react-loop.aborted-mid-dispatch", { sessionId, turnId, iteration });
      return { completed: false, iterations: iteration };
    }
    // → goto 1: loop back to the top, re-reading the store fresh.
  }

  // Unreachable in practice — the forceFinal branch above always fires (and
  // returns) on iteration === maxIterations, and the config schema's
  // `.min(1)` forbids maxIterations from ever being 0. Kept as a typed,
  // logged fallback rather than an unprovable-to-the-compiler implicit
  // `undefined` return.
  log.warn("react-loop.exhausted-without-final", { sessionId, turnId, iterations: iteration });
  return { completed: false, iterations: iteration };
}
