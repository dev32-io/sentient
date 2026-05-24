import OpenAI from "openai";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider, LLMStreamChunk, LLMStreamOptions, LLMToolCall } from "./llm-types.ts";

const log = getLog(["sentient", "llm"]);

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  siteName?: string;
  timeoutMs?: number;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function createOpenRouterProvider(config: OpenRouterConfig): LLMProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    defaultHeaders: {
      "HTTP-Referer": config.siteName ?? "Sentient",
      "X-Title": config.siteName ?? "Sentient",
    },
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return {
    async *stream(options: LLMStreamOptions): AsyncGenerator<LLMStreamChunk> {
      const startTime = Date.now();
      const hasTools = (options.tools?.length ?? 0) > 0;
      const toolNames = hasTools
        ? (options.tools ?? []).map((t) => (t as { function?: { name?: string } }).function?.name ?? "?")
        : [];
      log.info("stream-start", {
        model: options.model,
        messageCount: options.messages.length,
        hasTools,
        toolNames,
        toolChoice: options.tool_choice ?? "auto",
      });

      const response = await client.chat.completions.create(
        {
          model: options.model,
          messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
          stream: true,
          // Surface usage (incl. prompt_tokens_details.cached_tokens) on the
          // final stream chunk so we can verify cache hit-rate empirically.
          stream_options: { include_usage: true },
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: options.temperature ?? null,
          ...(hasTools && {
            tools: options.tools as OpenAI.Chat.ChatCompletionTool[],
            tool_choice: options.tool_choice ?? "auto",
          }),
        },
        { signal: options.signal },
      );

      // Accumulate partial tool call arguments by index
      const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let usage: OpenAI.CompletionUsage | undefined;

      for await (const chunk of response) {
        if (options.signal.aborted) return;
        if (chunk.usage) usage = chunk.usage;

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          log.debug("token", { length: delta.content.length });
          yield { type: "text", content: delta.content };
        }

        // Tool call deltas — accumulate by index AND forward per-chunk
        // deltas so downstream streaming effects (e.g., the speak effect's
        // UtteranceAggregator) can consume argument text as it arrives,
        // before the full JSON is closed.
        if (delta.tool_calls) {
          for (const toolCallDelta of delta.tool_calls) {
            const idx = toolCallDelta.index;
            const existing = pendingToolCalls.get(idx);

            const nameChunk = toolCallDelta.function?.name;
            const argsChunk = toolCallDelta.function?.arguments;

            if (!existing) {
              pendingToolCalls.set(idx, {
                id: toolCallDelta.id ?? "",
                name: nameChunk ?? "",
                arguments: argsChunk ?? "",
              });
            } else {
              if (toolCallDelta.id) existing.id = toolCallDelta.id;
              if (nameChunk) existing.name += nameChunk;
              if (argsChunk) existing.arguments += argsChunk;
            }

            const current = pendingToolCalls.get(idx);
            if (current && (nameChunk || argsChunk)) {
              const deltaChunk: LLMStreamChunk = {
                type: "tool_call_delta",
                delta: {
                  id: current.id,
                  index: idx,
                  ...(nameChunk ? { nameChunk } : {}),
                  ...(argsChunk ? { argsChunk } : {}),
                },
              };
              yield deltaChunk;
            }
          }
        }

        // When tool_calls finish, yield all accumulated tool calls
        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason === "tool_calls") {
          for (const [, pending] of pendingToolCalls) {
            const toolCall: LLMToolCall = {
              id: pending.id,
              function: { name: pending.name, arguments: pending.arguments },
            };
            log.debug("tool-call", { id: toolCall.id, name: toolCall.function.name });
            yield { type: "tool_call", toolCall };
          }
          pendingToolCalls.clear();
        }
      }

      const durationMs = Date.now() - startTime;
      const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const cacheHitRatio = promptTokens > 0 ? cachedTokens / promptTokens : 0;
      log.info("stream-end", {
        durationMs,
        promptTokens,
        cachedTokens,
        cacheHitRatio: Number(cacheHitRatio.toFixed(3)),
        completionTokens: usage?.completion_tokens ?? 0,
      });
    },
  };
}
