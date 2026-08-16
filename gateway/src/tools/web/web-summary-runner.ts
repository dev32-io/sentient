import { z } from "zod";
import type { ProviderClient } from "../../provider/provider-client.js";

export interface SummarySource {
  id: number;
  title: string;
  url: string;
  passage: string;
}
export interface WebSummaryConfig {
  fallbackModel: string;
  deadlineMs: number;
  maxInputChars: number;
  maxOutputTokens: number;
  maxAnswerChars: number;
}
export interface WebSummaryResult {
  answer: string;
  citations: number[];
  mode: "selected_model" | "fallback_model" | "deterministic";
}
export interface WebSummaryRunnerDeps {
  provider: ProviderClient;
  config: WebSummaryConfig;
  prompt: string;
  screen: (text: string) => string;
}

const outputSchema = z
  .object({
    answer: z.string().min(1),
    citations: z.array(z.number().int().positive()).max(20),
  })
  .strict();

function deterministic(query: string, sources: readonly SummarySource[], maxChars: number): WebSummaryResult {
  const lines = sources.map((s) => `[${s.id}] ${s.title}: ${s.passage.replace(/\s+/g, " ").trim()} (${s.url})`);
  return {
    answer: `Results for ${query}:\n${lines.join("\n")}`.slice(0, maxChars),
    citations: sources.map((s) => s.id),
    mode: "deterministic",
  };
}

/** No-tools utility workload. Both model attempts share one wall-clock budget;
 * cancellation closes the provider stream and can never produce a late value. */
export class WebSummaryRunner {
  constructor(private readonly deps: WebSummaryRunnerDeps) {}

  async run(query: string, sources: readonly SummarySource[], signal: AbortSignal): Promise<WebSummaryResult> {
    const deadline = AbortSignal.timeout(this.deps.config.deadlineMs);
    const combined = AbortSignal.any([signal, deadline]);
    const sourceBlock = sources
      .map((s) => `SOURCE [${s.id}]\nTitle: ${s.title}\nURL: ${s.url}\nPassage: ${s.passage}`)
      .join("\n\n");
    const input = `${this.deps.prompt}\n\nQuestion: ${query}\n\n${sourceBlock}`.slice(
      0,
      this.deps.config.maxInputChars,
    );
    for (const attempt of [undefined, this.deps.config.fallbackModel] as const) {
      if (combined.aborted) break;
      try {
        let text = "";
        for await (const chunk of this.deps.provider.stream({
          messages: [{ role: "user", content: input }],
          tools: [],
          signal: combined,
          maxOutputTokens: this.deps.config.maxOutputTokens,
          reasoningEffort: "low",
          ...(attempt ? { model: attempt } : {}),
        })) {
          if (combined.aborted) break;
          if (chunk.type === "text") {
            text += chunk.content;
            if (text.length > this.deps.config.maxAnswerChars * 4) throw new Error("summary oversize");
          }
        }
        if (combined.aborted) break;
        const parsed = outputSchema.safeParse(JSON.parse(text));
        if (!parsed.success || parsed.data.citations.some((id) => !sources.some((s) => s.id === id)))
          throw new Error("invalid summary");
        return {
          answer: this.deps.screen(parsed.data.answer).slice(0, this.deps.config.maxAnswerChars),
          citations: [...new Set(parsed.data.citations)],
          mode: attempt ? "fallback_model" : "selected_model",
        };
      } catch {
        if (combined.aborted) break;
      }
    }
    if (signal.aborted) return { answer: "Web search was cancelled.", citations: [], mode: "deterministic" };
    const fallback = deterministic(query, sources, this.deps.config.maxAnswerChars);
    return { ...fallback, answer: this.deps.screen(fallback.answer) };
  }
}
