/**
 * Fish Audio `/model` browsing client.
 *
 * Self-contained, removable module — see gateway/src/providers/fish/.
 * Fish Audio's voice catalog is public browsing (no auth required to list
 * or fetch a single model); auth is only required for TTS synthesis calls.
 * We still send the bearer when present, in case Fish rate-limits
 * anonymous traffic more aggressively, but never gate the request on it.
 */
import type { Result } from "@sentient/protocol";
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { VoiceEntry } from "./fish-voice-types.js";

const log = getLog(["sentient", "providers", "fish", "fetcher"]);

export type FishFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string }
  | { kind: "not-found" };

export interface FishFetchConfig {
  apiKey: string | null;
  timeoutMs: number;
  baseUrl?: string;
}

export interface FishFetchOpts {
  /** Optional substring search against voice title; mapped to Fish's `title` query. */
  title?: string;
  /** 1-indexed page number; defaults to 1. */
  page?: number;
}

export interface FishVoicePage {
  voices: VoiceEntry[];
  /** True when this page returned a full slice — caller can keep paginating. */
  hasMore: boolean;
}

const FISH_BASE_URL = "https://api.fish.audio";
// Pull a generous slice in one shot; client paginates and filters from this
// cache. `score` order keeps the catalog ranked by Fish's own popularity.
const FETCH_PAGE_SIZE = 200;
const FETCH_SORT_BY = "score";
const HTTP_NOT_FOUND = 404;

const voiceItemSchema = z.object({
  _id: z.string(),
  title: z.string(),
  description: z.string().optional().default(""),
  languages: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  cover_image: z.string().nullable().optional(),
  samples: z
    .array(z.object({ audio: z.string() }))
    .optional()
    .default([]),
  visibility: z.enum(["public", "private"]).optional().default("public"),
  task_count: z.number().optional().default(0),
  created_at: z.string().optional().default(""),
});

const listResponseSchema = z.object({
  items: z.array(voiceItemSchema),
});

type RawVoice = z.infer<typeof voiceItemSchema>;

function mapToVoiceEntry(v: RawVoice): VoiceEntry {
  return {
    id: v._id,
    title: v.title,
    description: v.description,
    languages: v.languages,
    tags: v.tags,
    coverImageUrl: v.cover_image ?? null,
    previewAudioUrl: v.samples[0]?.audio ?? null,
    visibility: v.visibility,
    taskCount: v.task_count,
    createdAt: v.created_at,
  };
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function handleFetchException(err: unknown, timeoutMs: number, scope: string): Result<never, FishFetchError> {
  // AbortSignal.timeout() fires a DOMException named "TimeoutError" (WHATWG
  // spec); a manual controller.abort() would fire "AbortError". Both are
  // abort-origin for this code path and map to the timeout error kind.
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    log.warn(`${scope}.timeout`, { afterMs: timeoutMs });
    return { ok: false, error: { kind: "timeout", afterMs: timeoutMs } };
  }
  const reason = err instanceof Error ? err.message : String(err);
  log.warn(`${scope}.fetchFailed`, { reason });
  return { ok: false, error: { kind: "fetch-error", status: 0 } };
}

async function parseJsonBody(resp: Response, scope: string): Promise<Result<unknown, FishFetchError>> {
  try {
    return { ok: true, value: await resp.json() };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`${scope}.jsonParseFailed`, { reason });
    return { ok: false, error: { kind: "parse-error", reason } };
  }
}

async function performListFetch(cfg: FishFetchConfig, opts: FishFetchOpts): Promise<Result<Response, FishFetchError>> {
  const baseUrl = cfg.baseUrl ?? FISH_BASE_URL;
  try {
    const params = new URLSearchParams({
      page_size: String(FETCH_PAGE_SIZE),
      sort_by: FETCH_SORT_BY,
    });
    const page = opts.page && opts.page > 1 ? opts.page : 1;
    if (page > 1) params.set("page_number", String(page));
    if (opts.title && opts.title.trim() !== "") {
      params.set("title", opts.title.trim());
    }
    const resp = await fetch(`${baseUrl}/model?${params.toString()}`, {
      headers: authHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    return { ok: true, value: resp };
  } catch (err) {
    return handleFetchException(err, cfg.timeoutMs, "fetchFishVoices");
  }
}

export async function fetchFishVoices(
  cfg: FishFetchConfig,
  opts: FishFetchOpts = {},
): Promise<Result<FishVoicePage, FishFetchError>> {
  const start = Date.now();
  log.info("fetchFishVoices.begin", { page: opts.page ?? 1, hasTitleFilter: Boolean(opts.title?.trim()) });

  const fetched = await performListFetch(cfg, opts);
  if (!fetched.ok) return fetched;
  const resp = fetched.value;

  if (!resp.ok) {
    log.warn("fetchFishVoices.nonOk", { status: resp.status });
    return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  }

  const body = await parseJsonBody(resp, "fetchFishVoices");
  if (!body.ok) return body;

  const parsed = listResponseSchema.safeParse(body.value);
  if (!parsed.success) {
    log.warn("fetchFishVoices.schemaParseFailed", { reason: parsed.error.message });
    return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  }

  const voices = parsed.data.items.map(mapToVoiceEntry);
  const hasMore = voices.length >= FETCH_PAGE_SIZE;
  log.info("fetchFishVoices.done", { count: voices.length, hasMore, elapsedMs: Date.now() - start });
  return { ok: true, value: { voices, hasMore } };
}

export async function fetchFishVoiceById(
  cfg: FishFetchConfig,
  id: string,
): Promise<Result<VoiceEntry, FishFetchError>> {
  const start = Date.now();
  log.info("fetchFishVoiceById.begin", { id });
  const baseUrl = cfg.baseUrl ?? FISH_BASE_URL;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/model/${encodeURIComponent(id)}`, {
      headers: authHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    return handleFetchException(err, cfg.timeoutMs, "fetchFishVoiceById");
  }

  if (resp.status === HTTP_NOT_FOUND) {
    log.info("fetchFishVoiceById.notFound", { id });
    return { ok: false, error: { kind: "not-found" } };
  }
  if (!resp.ok) {
    log.warn("fetchFishVoiceById.nonOk", { id, status: resp.status });
    return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  }

  const body = await parseJsonBody(resp, "fetchFishVoiceById");
  if (!body.ok) return body;

  const parsed = voiceItemSchema.safeParse(body.value);
  if (!parsed.success) {
    log.warn("fetchFishVoiceById.schemaParseFailed", { id, reason: parsed.error.message });
    return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  }

  log.info("fetchFishVoiceById.done", { id, elapsedMs: Date.now() - start });
  return { ok: true, value: mapToVoiceEntry(parsed.data) };
}
