import type { OrchestratorConfig } from "@sentient/config";
import OpenAI from "openai";
import { getLog } from "../logging/logger.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "./provider-client.js";
import { ToolCallAccumulator } from "./tool-call-accumulator.js";

const log = getLog(["sentient", "provider", "openai"]);

/** Usage tallies read off the terminal `chunk.usage` (stream_options.include_usage). */
type StreamUsage = { promptTokens: number; cachedTokens: number; completionTokens: number };

export function createOpenAIProvider(cfg: OrchestratorConfig["provider"], apiKey: string): ProviderClient {
  const client = new OpenAI({
    apiKey,
    baseURL: cfg.base_url,
    defaultHeaders: { "HTTP-Referer": cfg.site_name, "X-Title": cfg.site_name },
    timeout: cfg.request_timeout_ms,
  });

  return {
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
      if (req.signal.aborted) return; // already-aborted: skip create() entirely, yield nothing

      const startedAt = Date.now();
      const hasTools = req.tools.length > 0;
      const maxOutputTokens = req.maxOutputTokens ?? cfg.max_output_tokens;
      // "unset" is the operator's escape hatch (distinct from "none": the
      // OpenAI SDK types "none" as a REAL `reasoning_effort` value — zero
      // reasoning effort, but the field is still sent and the provider is
      // expected to understand it. Overloading "none" to also mean "omit the
      // field" would silently break that real value for a provider that
      // supports it). "unset" OMITS the field from the request entirely —
      // see the field comment below and `orchestrator.provider.reasoning_effort`
      // in config.yaml/the zod schema.
      //
      // A per-request override (`req.reasoningEffort` — auxiliary tasks ask
      // for "none") narrows the value, but CANNOT re-introduce the field the
      // operator turned off: the operator's "unset" is checked first and wins,
      // because it exists precisely for an endpoint that 400s on the unknown
      // field. Both directions of the check are load-bearing.
      const requested = req.reasoningEffort ?? cfg.reasoning_effort;
      const isOmitted = cfg.reasoning_effort === "unset" || requested === "unset";
      const reasoningEffort = isOmitted ? undefined : requested;
      log.info("stream-start", {
        model: cfg.model,
        messageCount: req.messages.length,
        toolCount: req.tools.length,
        maxOutputTokens,
        reasoningEffort: requested,
        reasoningEffortSent: reasoningEffort !== undefined,
      });

      let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
      try {
        response = await client.chat.completions.create(
          {
            model: cfg.model,
            messages: req.messages as OpenAI.Chat.ChatCompletionMessageParam[],
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: maxOutputTokens,
            // Never sent before task 18 (D17): reasoning is the invisible
            // phase that delays the first spoken word, and a household voice
            // assistant wants an answer sooner. Sent on every call whose
            // config isn't "unset" — an OpenAI-compatible endpoint that does
            // not recognize the field is EXPECTED to ignore it (the norm for
            // extra JSON fields on these APIs), but that is an expectation,
            // not a guarantee: a STRICT endpoint that 400s on an unknown
            // field would fail EVERY turn until reconfigured, a wider blast
            // radius than one bad request. No per-provider capability probe
            // exists to detect that ahead of time, so the documented escape
            // hatch is config, not code: set
            // `orchestrator.provider.reasoning_effort: unset` to omit this
            // field entirely (see below — spread rather than an explicit
            // `undefined` value, since `exactOptionalPropertyTypes` forbids
            // assigning `undefined` to an optional field the SDK types as
            // `ReasoningEffort | null`).
            // Short of that, on the rare provider that rejects the request
            // outright, the throw below still reaches session-runtime.ts's
            // existing "runTurn threw" backstop, which fails the turn with a
            // user-visible notice rather than crashing — the same safety net
            // every other provider error already relies on.
            ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
            ...(hasTools ? { tools: req.tools as OpenAI.Chat.ChatCompletionTool[], tool_choice: "auto" as const } : {}),
          },
          { signal: req.signal },
        );
      } catch (err) {
        // The SDK's makeRequest throws APIUserAbortError synchronously when the
        // signal is already aborted, or asynchronously if it aborts before
        // headers arrive — neither path is a real provider error.
        if (req.signal.aborted) return;
        throw err;
      }

      const acc = new ToolCallAccumulator();
      let finishReason = "stop";
      let usage: StreamUsage | undefined;

      for await (const chunk of response) {
        if (req.signal.aborted) return; // stop consuming, do not throw
        const choice = chunk.choices[0];
        if (choice?.delta?.content) yield { type: "text", content: choice.delta.content };
        if (choice?.delta?.tool_calls) acc.feed(choice.delta.tool_calls);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }

      // The OpenAI SDK swallows AbortError inside its own SSE iterator (exits
      // the `for await` above silently, no throw) — so a mid-stream abort
      // falls through to here rather than hitting the in-loop check. Re-check
      // post-loop: an aborted request must stop yielding entirely, not emit a
      // flushed tool-call batch or a synthetic "done" for a cycle the caller
      // already abandoned.
      if (req.signal.aborted) return;

      // Flush accumulated tool calls REGARDLESS of finish_reason — a provider
      // finishing "stop"/"length" mid-call must not silently drop them.
      for (const tc of acc.flush()) yield { type: "tool_call", toolCall: tc };

      const cacheHitRatio = usage && usage.promptTokens > 0 ? usage.cachedTokens / usage.promptTokens : 0;
      log.info("stream-end", {
        durationMs: Date.now() - startedAt,
        finishReason,
        ...(usage ?? {}),
        cacheHitRatio: Number(cacheHitRatio.toFixed(3)),
      });
      yield { type: "done", finishReason, ...(usage !== undefined ? { usage } : {}) };
    },
  };
}
