import type { Result } from "@sentient/protocol";
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { ModelEntry } from "./types.js";

const log = getLog(["sentient", "providers", "catalogs", "ollama"]);
const SHOW_CONCURRENCY = 4;

export type OllamaFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string };

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaFetcherConfig {
  /** Origin-only base, default https://ollama.com — the daemon-side
   * base_url (which would be /v1 for OpenAI-compat completions) is a
   * different concern. */
  baseUrl: string;
  timeoutMs: number;
  fetch?: Fetch;
  /** Prior endpoint-derived entries used only when /api/show fails for an exact current inventory ID. */
  priorModels?: readonly ModelEntry[];
}

const responseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional(),
      modified_at: z.string().optional(),
      size: z.number().int().nonnegative().optional().default(0),
      details: z
        .object({
          parameter_size: z.string().optional().default(""),
          family: z.string().optional().default(""),
        })
        .optional(),
    }),
  ),
});

const showResponseSchema = z.object({
  capabilities: z.array(z.string()),
  model_info: z.record(z.unknown()).optional().default({}),
});

type RawModel = z.infer<typeof responseSchema>["models"][number];
type ShowResponse = z.infer<typeof showResponseSchema>;

export interface OllamaModelEntry extends ModelEntry {
  /** Fresh `/api/show` metadata was complete for this inventory read. Internal only. */
  metadataComplete: boolean;
  /** Capability booleans are authoritative, including exact-ID last-known endpoint values. Internal only. */
  capabilitiesKnown: boolean;
}

function toCloudTag(name: string): string {
  return name.includes(":") ? `${name}-cloud` : `${name}:cloud`;
}

function displayName(name: string): string {
  const idx = name.indexOf(":");
  if (idx === -1) return name;
  return `${name.slice(0, idx)} (${name.slice(idx + 1).toUpperCase()})`;
}

function validContextLength(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function contextLength(modelInfo: Record<string, unknown>): number {
  const architecture = modelInfo["general.architecture"];
  if (typeof architecture === "string") {
    const declared = modelInfo[`${architecture}.context_length`];
    if (validContextLength(declared)) return declared;
  }

  const candidates = Object.entries(modelInfo).filter(
    ([key, value]) => key.endsWith(".context_length") && validContextLength(value),
  );
  return candidates.length === 1 ? (candidates[0]?.[1] as number) : 0;
}

function mapToModelEntry(model: RawModel, metadata?: ShowResponse, prior?: ModelEntry): OllamaModelEntry {
  return {
    id: toCloudTag(model.name),
    provider: "ollama-cloud",
    name: displayName(model.name),
    description: "",
    contextLength: metadata ? contextLength(metadata.model_info) : (prior?.contextLength ?? 0),
    pricingPer1mPrompt: "included",
    pricingPer1mCompletion: "included",
    supportsTools: metadata?.capabilities.includes("tools") ?? prior?.supportsTools ?? false,
    supportsVision: metadata?.capabilities.includes("vision") ?? prior?.supportsVision ?? false,
    metadataComplete: metadata !== undefined,
    capabilitiesKnown:
      metadata !== undefined ||
      (prior !== undefined && (!("capabilitiesKnown" in prior) || prior.capabilitiesKnown === true)),
  };
}

function originFor(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

async function fetchMetadata(
  fetchFn: Fetch,
  url: string,
  model: string,
  signal: AbortSignal,
): Promise<ShowResponse | undefined> {
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!response.ok) return undefined;
    const parsed = showResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function enrichModels(
  models: RawModel[],
  fetchFn: Fetch,
  origin: string,
  signal: AbortSignal,
  priorModels: readonly ModelEntry[],
): Promise<OllamaModelEntry[]> {
  const priorById = new Map(
    priorModels.filter((model) => model.provider === "ollama-cloud").map((model) => [model.id, model]),
  );
  const entries = models.map((model) => mapToModelEntry(model, undefined, priorById.get(toCloudTag(model.name))));
  let next = 0;
  let failures = 0;

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const index = next++;
      const model = models[index];
      if (!model) return;
      const metadata = await fetchMetadata(fetchFn, `${origin}/api/show`, model.name, signal);
      if (metadata) entries[index] = mapToModelEntry(model, metadata);
      else failures++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, models.length) }, () => worker()));
  if (failures > 0) log.warn("fetchOllamaCloudModels.metadataIncomplete", { failures, count: models.length });
  return entries;
}

export async function fetchOllamaCloudModels(
  config: OllamaFetcherConfig,
): Promise<Result<OllamaModelEntry[], OllamaFetchError>> {
  const start = Date.now();
  const origin = originFor(config.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const fetchFn = config.fetch ?? globalThis.fetch;
  log.info("fetchOllamaCloudModels.begin");

  try {
    let response: Response;
    try {
      response = await fetchFn(`${origin}/api/tags`, { signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        log.warn("fetchOllamaCloudModels.timeout", { afterMs: config.timeoutMs });
        return { ok: false, error: { kind: "timeout", afterMs: config.timeoutMs } };
      }
      log.warn("fetchOllamaCloudModels.fetchFailed");
      return { ok: false, error: { kind: "fetch-error", status: 0 } };
    }

    if (!response.ok) {
      log.warn("fetchOllamaCloudModels.nonOk", { status: response.status });
      return { ok: false, error: { kind: "fetch-error", status: response.status } };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      log.warn("fetchOllamaCloudModels.parseFailed");
      return { ok: false, error: { kind: "parse-error", reason: "Invalid JSON" } };
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      log.warn("fetchOllamaCloudModels.parseFailed");
      return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
    }

    const models = await enrichModels(parsed.data.models, fetchFn, origin, controller.signal, config.priorModels ?? []);
    log.info("fetchOllamaCloudModels.done", { count: models.length, elapsedMs: Date.now() - start });
    return { ok: true, value: models };
  } finally {
    clearTimeout(timeout);
  }
}
