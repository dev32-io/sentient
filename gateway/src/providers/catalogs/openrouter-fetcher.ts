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
      supported_parameters: z.unknown().optional(),
      architecture: z.unknown().optional(),
    }),
  ),
});

type RawModel = z.infer<typeof responseSchema>["data"][number];

export interface OpenRouterModelEntry extends ModelEntry {
  /** Internal field-presence status. Stripped from public catalog DTOs. */
  readonly visionCapabilityKnown: boolean;
  readonly toolsCapabilityKnown: boolean;
}

const PRICE_SCALE_PER_1M = 1_000_000;

function mapToModelEntry(m: RawModel): OpenRouterModelEntry {
  const parameters = stringArray(m.supported_parameters);
  const vision = inputVisionCapability(m.architecture);
  return {
    id: m.id,
    provider: "openrouter",
    name: m.name,
    description: m.description,
    contextLength: m.context_length,
    pricingPer1mPrompt: m.pricing ? Number(m.pricing.prompt) * PRICE_SCALE_PER_1M : 0,
    pricingPer1mCompletion: m.pricing ? Number(m.pricing.completion) * PRICE_SCALE_PER_1M : 0,
    supportsTools: parameters?.includes("tools") ?? false,
    supportsVision: vision.supported,
    toolsCapabilityKnown: parameters !== null,
    visionCapabilityKnown: vision.known,
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function inputVisionCapability(value: unknown): { known: boolean; supported: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { known: false, supported: false };
  const architecture = value as Record<string, unknown>;
  if (Object.hasOwn(architecture, "input_modalities")) {
    const modalities = stringArray(architecture.input_modalities);
    return modalities ? { known: true, supported: modalities.includes("image") } : { known: false, supported: false };
  }
  if (!Object.hasOwn(architecture, "modality") || typeof architecture.modality !== "string") {
    return { known: false, supported: false };
  }
  const sides = architecture.modality.split("->");
  if (sides.length !== 2 || sides.some((side) => !/^[a-z0-9_-]+(?:\+[a-z0-9_-]+)*$/iu.test(side))) {
    return { known: false, supported: false };
  }
  return { known: true, supported: sides[0]?.split("+").includes("image") === true };
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
    log.warn("fetchOpenRouterModels.fetchFailed", { reason: "network_error" });
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
}

export async function fetchOpenRouterModels(
  config: OpenRouterFetcherConfig,
): Promise<Result<OpenRouterModelEntry[], OpenRouterFetchError>> {
  const start = Date.now();
  log.info("fetchOpenRouterModels.begin");

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
