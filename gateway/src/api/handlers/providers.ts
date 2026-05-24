import { getLog } from "../../logging/logger.js";
import type { ModelEntry, VoiceEntry } from "../../providers/catalogs/types.js";
import type { TokenService } from "../../user-auth/token-service.js";

const log = getLog(["sentient", "gateway", "api", "providers"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_UNAVAILABLE = 503;

const PATH_MODELS = "/api/v1/providers/models";
const PATH_VOICES = "/api/v1/providers/voices";
const PATH_VOICE_BY_ID_PREFIX = "/api/v1/providers/voices/";

export type ProvidersListResult<T> = { ok: true; value: T; stale?: boolean } | { ok: false; error: { kind: string } };

export interface VoicePage {
  voices: VoiceEntry[];
  hasMore: boolean;
}

export interface ListVoicesOptions {
  title?: string;
  page?: number;
}

export interface ProvidersHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  listModels: () => Promise<ProvidersListResult<ModelEntry[]>>;
  listVoices: (opts?: ListVoicesOptions) => Promise<ProvidersListResult<VoicePage>>;
  getVoice: (id: string) => Promise<ProvidersListResult<VoiceEntry>>;
}

export function createProvidersHandler(deps: ProvidersHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => handleProviders(deps, request);
}

async function handleProviders(deps: ProvidersHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const auth = await authorize(deps, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  if (url.pathname === PATH_MODELS) {
    return respondList(await deps.listModels(), "models");
  }
  if (url.pathname === PATH_VOICES) {
    const opts = parseListVoicesOptions(url.searchParams);
    return respondVoiceList(await deps.listVoices(opts));
  }
  if (url.pathname.startsWith(PATH_VOICE_BY_ID_PREFIX)) {
    const id = decodeURIComponent(url.pathname.slice(PATH_VOICE_BY_ID_PREFIX.length));
    if (!id || id.includes("/")) {
      return new Response("Not Found", { status: HTTP_NOT_FOUND });
    }
    return respondVoice(await deps.getVoice(id));
  }
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

function respondVoice(result: ProvidersListResult<VoiceEntry>): Response {
  if (result.ok) {
    log.info("providers.get-voice", { id: result.value.id });
    return Response.json({ voice: result.value }, { status: HTTP_OK });
  }
  if (result.error.kind === "not-found") {
    return jsonError(HTTP_NOT_FOUND, "voice-not-found");
  }
  log.warn("providers.get-voice-upstream-failed", { kind: result.error.kind });
  return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
}

interface AuthOk {
  ok: true;
  userId: string;
}
interface AuthFail {
  ok: false;
  response: Response;
}

async function authorize(deps: ProvidersHandlerDeps, request: Request): Promise<AuthOk | AuthFail> {
  const token = readBearer(request);
  if (!token) return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, "missing-token") };

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("providers.token-rejected", { reason: valid.error });
    return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, valid.error) };
  }
  return { ok: true, userId: valid.value.userId };
}

function respondList<T>(result: ProvidersListResult<T>, key: "models" | "voices"): Response {
  if (!result.ok) {
    log.warn("providers.upstream-unavailable", { key, kind: result.error.kind });
    return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
  }
  const stale = result.stale ?? false;
  log.info("providers.list", { key, stale });
  return Response.json({ [key]: result.value, stale }, { status: HTTP_OK });
}

function respondVoiceList(result: ProvidersListResult<VoicePage>): Response {
  if (!result.ok) {
    log.warn("providers.upstream-unavailable", { key: "voices", kind: result.error.kind });
    return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
  }
  const stale = result.stale ?? false;
  log.info("providers.list", { key: "voices", stale, hasMore: result.value.hasMore });
  return Response.json({ voices: result.value.voices, hasMore: result.value.hasMore, stale }, { status: HTTP_OK });
}

function parseListVoicesOptions(params: URLSearchParams): ListVoicesOptions {
  const opts: ListVoicesOptions = {};
  const title = params.get("title");
  if (title !== null) opts.title = title;
  const pageRaw = params.get("page");
  if (pageRaw !== null) {
    const page = Number.parseInt(pageRaw, 10);
    if (Number.isFinite(page) && page >= 1) opts.page = page;
  }
  return opts;
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
