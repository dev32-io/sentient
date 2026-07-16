/**
 * Gated Fish Audio voice-library browse proxy.
 *
 * Self-contained, removable module — mirrors gateway/src/providers/fish/.
 * `handleFishBrowse` is the ONLY export the core providers handler imports;
 * deleting this directory + its one mount block fully removes the feature.
 *
 * Every route 404s when `fishBrowseEnabled` is false — checked FIRST, before
 * auth, so a disabled deploy leaks no information about the route existing.
 */
import { getLog } from "../../../logging/logger.js";
import type { FishFetchConfig, FishVoicePage } from "../../../providers/fish/fish-fetcher.js";
import { fetchFishVoiceById, fetchFishVoices } from "../../../providers/fish/fish-fetcher.js";
import type { TokenService } from "../../../user-auth/token-service.js";
import { type TtlCache, createTtlCache } from "../../../util/ttl-cache.js";

const log = getLog(["sentient", "api", "fish", "browse"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_UNAVAILABLE = 503;

/** Exact-match list path. */
export const FISH_VOICES_PATH = "/api/v1/providers/voices";
/** `/api/v1/providers/voices/<id>` — single path segment, no further nesting. */
export const VOICE_ID_SUBPATH = /^\/api\/v1\/providers\/voices\/([^/]+)$/;

const CACHE_KEY = "default";

export interface FishBrowseFetchers {
  fish?: typeof fetchFishVoices;
  fishById?: typeof fetchFishVoiceById;
}

export interface FishBrowseDeps {
  tokens: Pick<TokenService, "validate">;
  fishBrowseEnabled: boolean;
  fishApiKey: string | null;
  timeoutMs: number;
  cacheTtlMs: number;
  fetchers?: FishBrowseFetchers;
}

interface ListVoicesOptions {
  title?: string;
  page?: number;
}

// Keyed by deps object identity, not mutated onto deps (never mutate
// parameters). Production wiring constructs one FishBrowseDeps at mount time
// and reuses it across requests, so the cache persists naturally; tests get
// the same behavior by reusing one deps object across calls.
const cacheRegistry = new WeakMap<FishBrowseDeps, TtlCache<FishVoicePage>>();

function resolveCache(deps: FishBrowseDeps): TtlCache<FishVoicePage> {
  const existing = cacheRegistry.get(deps);
  if (existing) return existing;
  const created = createTtlCache<FishVoicePage>();
  cacheRegistry.set(deps, created);
  return created;
}

export async function handleFishBrowse(deps: FishBrowseDeps, request: Request): Promise<Response> {
  if (!deps.fishBrowseEnabled) {
    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
  }
  const auth = await authorize(deps, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  if (url.pathname === FISH_VOICES_PATH) {
    return handleList(deps, url.searchParams);
  }
  const idMatch = VOICE_ID_SUBPATH.exec(url.pathname);
  if (idMatch?.[1]) {
    return handleGetById(deps, decodeURIComponent(idMatch[1]));
  }
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

interface AuthOk {
  ok: true;
}
interface AuthFail {
  ok: false;
  response: Response;
}

async function authorize(deps: FishBrowseDeps, request: Request): Promise<AuthOk | AuthFail> {
  const token = readBearer(request);
  if (!token) return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, "missing-token") };

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("browse.token-rejected", { reason: valid.error });
    return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, valid.error) };
  }
  return { ok: true };
}

function parseListOptions(params: URLSearchParams): ListVoicesOptions {
  const opts: ListVoicesOptions = {};
  const title = params.get("title")?.trim();
  if (title) opts.title = title;
  const pageRaw = params.get("page");
  if (pageRaw !== null) {
    const page = Number.parseInt(pageRaw, 10);
    if (Number.isFinite(page) && page >= 1) opts.page = page;
  }
  return opts;
}

async function handleList(deps: FishBrowseDeps, params: URLSearchParams): Promise<Response> {
  const opts = parseListOptions(params);
  const cacheable = !opts.title && (opts.page ?? 1) === 1;
  const cache = resolveCache(deps);

  if (cacheable) {
    const fresh = cache.get(CACHE_KEY);
    if (fresh !== undefined) {
      log.debug("voices.cache-hit", { count: fresh.voices.length, hasMore: fresh.hasMore });
      return voicesResponse(fresh, false);
    }
  }

  const fetchVoices = deps.fetchers?.fish ?? fetchFishVoices;
  log.info("voices.begin", { hasTitleFilter: Boolean(opts.title), page: opts.page ?? 1, cacheable });
  const result = await fetchVoices(fishConfig(deps), opts);
  if (result.ok) {
    if (cacheable) cache.set(CACHE_KEY, result.value, deps.cacheTtlMs);
    log.info("voices.done", { count: result.value.voices.length, hasMore: result.value.hasMore });
    return voicesResponse(result.value, false);
  }

  log.warn("voices.upstream-failed", { kind: result.error.kind, cacheable });
  if (!cacheable) return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
  return staleVoicesOrError(cache);
}

function staleVoicesOrError(cache: TtlCache<FishVoicePage>): Response {
  const stale = cache.getStale(CACHE_KEY);
  if (stale !== undefined) {
    log.warn("voices.stale-fallback", { count: stale.voices.length });
    return voicesResponse(stale, true);
  }
  return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
}

function voicesResponse(page: FishVoicePage, stale: boolean): Response {
  return Response.json({ voices: page.voices, hasMore: page.hasMore, stale }, { status: HTTP_OK });
}

async function handleGetById(deps: FishBrowseDeps, id: string): Promise<Response> {
  const fetchById = deps.fetchers?.fishById ?? fetchFishVoiceById;
  log.info("voice.begin", { id });
  const result = await fetchById(fishConfig(deps), id);
  if (result.ok) {
    log.info("voice.done", { id });
    return Response.json({ voice: result.value }, { status: HTTP_OK });
  }
  if (result.error.kind === "not-found") {
    log.info("voice.not-found", { id });
    return jsonError(HTTP_NOT_FOUND, "voice-not-found");
  }
  log.warn("voice.upstream-failed", { id, kind: result.error.kind });
  return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
}

function fishConfig(deps: FishBrowseDeps): FishFetchConfig {
  return { apiKey: deps.fishApiKey, timeoutMs: deps.timeoutMs };
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}
