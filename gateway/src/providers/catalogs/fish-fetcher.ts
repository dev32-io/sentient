import type { Result } from "@sentient/protocol";
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { VoiceEntry } from "./types.js";

const log = getLog(["sentient", "providers", "catalogs", "fish"]);

export type FishFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string }
  | { kind: "not-found" };

export interface FishFetcherConfig {
  apiKey: () => string | null;
  baseUrl: string;
  timeoutMs: number;
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

// Pull a generous slice in one shot; client paginates and filters from this
// cache. `score` order keeps the catalog ranked by Fish's own popularity.
const FETCH_PAGE_SIZE = 200;
const FETCH_SORT_BY = "score";

async function performListFetch(config: FishFetcherConfig): Promise<Result<Response, FishFetchError>> {
  // Fish Audio /model browsing is public — auth only required for TTS calls.
  // Send the bearer when present (in case Fish rate-limits anonymous traffic
  // more aggressively), but do not gate the request on its absence.
  const key = config.apiKey();
  try {
    const params = new URLSearchParams({
      page_size: String(FETCH_PAGE_SIZE),
      sort_by: FETCH_SORT_BY,
    });
    const page = config.page && config.page > 1 ? config.page : 1;
    if (page > 1) params.set("page_number", String(page));
    if (config.title && config.title.trim() !== "") {
      params.set("title", config.title.trim());
    }
    const url = `${config.baseUrl}/model?${params.toString()}`;
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    return { ok: true, value: resp };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn("fetchFishVoices.timeout", { afterMs: config.timeoutMs });
      return { ok: false, error: { kind: "timeout", afterMs: config.timeoutMs } };
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchFishVoices.fetchFailed", { reason });
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
}

export async function fetchFishVoices(config: FishFetcherConfig): Promise<Result<FishVoicePage, FishFetchError>> {
  const start = Date.now();
  log.info("fetchFishVoices.begin", { baseUrl: config.baseUrl, page: config.page ?? 1 });

  const fetched = await performListFetch(config);
  if (!fetched.ok) return fetched;
  const resp = fetched.value;

  if (!resp.ok) {
    log.warn("fetchFishVoices.nonOk", { status: resp.status });
    return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchFishVoices.parseFailed", { reason });
    return { ok: false, error: { kind: "parse-error", reason } };
  }

  const parsed = listResponseSchema.safeParse(body);
  if (!parsed.success) {
    log.warn("fetchFishVoices.parseFailed", { reason: parsed.error.message });
    return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  }

  const voices = parsed.data.items.map(mapToVoiceEntry);
  const hasMore = voices.length >= FETCH_PAGE_SIZE;
  log.info("fetchFishVoices.done", { count: voices.length, hasMore, elapsedMs: Date.now() - start });
  return { ok: true, value: { voices, hasMore } };
}

const HTTP_NOT_FOUND = 404;

export async function fetchFishVoiceById(
  config: Omit<FishFetcherConfig, "title">,
  id: string,
): Promise<Result<VoiceEntry, FishFetchError>> {
  const start = Date.now();
  log.info("fetchFishVoiceById.begin", { id });

  // Same as listing — single-voice browsing is public on Fish Audio.
  const key = config.apiKey();
  let resp: Response;
  try {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    resp = await fetch(`${config.baseUrl}/model/${encodeURIComponent(id)}`, {
      headers,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn("fetchFishVoiceById.timeout", { id, afterMs: config.timeoutMs });
      return { ok: false, error: { kind: "timeout", afterMs: config.timeoutMs } };
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchFishVoiceById.fetchFailed", { id, reason });
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }

  if (resp.status === HTTP_NOT_FOUND) {
    log.info("fetchFishVoiceById.notFound", { id });
    return { ok: false, error: { kind: "not-found" } };
  }
  if (!resp.ok) {
    log.warn("fetchFishVoiceById.nonOk", { id, status: resp.status });
    return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchFishVoiceById.parseFailed", { id, reason });
    return { ok: false, error: { kind: "parse-error", reason } };
  }

  const parsed = voiceItemSchema.safeParse(body);
  if (!parsed.success) {
    log.warn("fetchFishVoiceById.parseFailed", { id, reason: parsed.error.message });
    return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  }

  log.info("fetchFishVoiceById.done", { id, elapsedMs: Date.now() - start });
  return { ok: true, value: mapToVoiceEntry(parsed.data) };
}
