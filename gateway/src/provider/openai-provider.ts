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
      const startedAt = Date.now();
      const hasTools = req.tools.length > 0;
      log.info("stream-start", { model: cfg.model, messageCount: req.messages.length, toolCount: req.tools.length });

      const response = await client.chat.completions.create(
        {
          model: cfg.model,
          messages: req.messages as OpenAI.Chat.ChatCompletionMessageParam[],
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: cfg.max_output_tokens,
          ...(hasTools ? { tools: req.tools as OpenAI.Chat.ChatCompletionTool[], tool_choice: "auto" as const } : {}),
        },
        { signal: req.signal },
      );

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
