import type { Result } from "@sentient/protocol";
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { ModelEntry } from "./types.js";

const log = getLog(["sentient", "providers", "catalogs", "openrouter"]);

export type OpenRouterFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string };

export interface OpenRouterFetcherConfig {
  apiKey: () => string | null;
  baseUrl: string;
  timeoutMs: number;
}

const responseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional().default(""),
      context_length: z.number().int().nonnegative().optional().default(0),
      pricing: z
        .object({
          prompt: z.string().or(z.number()),
          completion: z.string().or(z.number()),
        })
        .optional(),
      supported_parameters: z.array(z.string()).optional().default([]),
      architecture: z
        .object({
          modality: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

type RawModel = z.infer<typeof responseSchema>["data"][number];

const PRICE_SCALE_PER_1M = 1_000_000;

function mapToModelEntry(m: RawModel): ModelEntry {
  return {
    id: m.id,
    provider: "openrouter",
    name: m.name,
    description: m.description,
    contextLength: m.context_length,
    pricingPer1mPrompt: m.pricing ? Number(m.pricing.prompt) * PRICE_SCALE_PER_1M : 0,
    pricingPer1mCompletion: m.pricing ? Number(m.pricing.completion) * PRICE_SCALE_PER_1M : 0,
    supportsTools: m.supported_parameters.includes("tools"),
    supportsVision: m.architecture?.modality?.includes("image") ?? false,
  };
}

async function performFetch(config: OpenRouterFetcherConfig): Promise<Result<Response, OpenRouterFetchError>> {
  const key = config.apiKey();
  if (!key) {
    log.warn("fetchOpenRouterModels.noKey");
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
  try {
    const resp = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    return { ok: true, value: resp };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn("fetchOpenRouterModels.timeout", { afterMs: config.timeoutMs });
      return { ok: false, error: { kind: "timeout", afterMs: config.timeoutMs } };
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchOpenRouterModels.fetchFailed", { reason });
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
}

export async function fetchOpenRouterModels(
  config: OpenRouterFetcherConfig,
): Promise<Result<ModelEntry[], OpenRouterFetchError>> {
  const start = Date.now();
  log.info("fetchOpenRouterModels.begin", { baseUrl: config.baseUrl });

  const fetched = await performFetch(config);
  if (!fetched.ok) return fetched;
  const resp = fetched.value;

  if (!resp.ok) {
    log.warn("fetchOpenRouterModels.nonOk", { status: resp.status });
    return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchOpenRouterModels.parseFailed", { reason });
    return { ok: false, error: { kind: "parse-error", reason } };
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    log.warn("fetchOpenRouterModels.parseFailed", { reason: parsed.error.message });
    return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  }

  const models = parsed.data.data.map(mapToModelEntry);
  log.info("fetchOpenRouterModels.done", { count: models.length, elapsedMs: Date.now() - start });
  return { ok: true, value: models };
}
