import { getLog } from "../../logging/logger.js";
import type { ModelEntry } from "../../providers/catalogs/types.js";
import type { TokenService } from "../../user-auth/token-service.js";
// Fish voice-library browse routes — self-contained, removable module. The
// mount block below (guarded by fishDeps presence) is the ONLY reference to
// it from this core handler; deleting handlers/fish/ + this block fully
// removes the feature.
import { FISH_VOICES_PATH, type FishBrowseDeps, VOICE_ID_SUBPATH, handleFishBrowse } from "./fish/fish-browse.js";
// Clone-from-Fish route — same self-contained-module discipline as the browse
// mount above; deleting handlers/fish/fish-clone.ts + this block fully
// removes the feature independently of the browse mount.
import { type FishCloneDeps, handleFishClone } from "./fish/fish-clone.js";

const log = getLog(["sentient", "gateway", "api", "providers"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;

const PATH_MODELS = "/api/v1/providers/models";
const CLONE_PATH_RE = /^\/api\/v1\/providers\/voices\/([^/]+)\/clone$/;

export type ProvidersListResult<T> = { ok: true; value: T; stale?: boolean } | { ok: false; error: { kind: string } };

export interface ProvidersHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  listModels: () => Promise<ProvidersListResult<ModelEntry[]>>;
  /** Fish voice-library browse deps. Omit entirely to keep the feature dark
   *  (e.g. headless / CI builds) — every /providers/voices* route 404s the
   *  same way it does when fishBrowseEnabled is false. */
  fishDeps?: FishBrowseDeps;
  /** Clone-from-Fish deps. Omit entirely to keep the feature dark, same as
   *  fishDeps — the route 404s (via fishBrowseEnabled) when configured. */
  fishCloneDeps?: FishCloneDeps;
}

export function createProvidersHandler(deps: ProvidersHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => handleProviders(deps, request);
}

async function handleProviders(deps: ProvidersHandlerDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Clone-from-Fish — POST, so it must be routed before the blanket GET-only
  // gate below. Self-contained mount, trivially removable (see the import
  // comment above).
  const { fishCloneDeps } = deps;
  if (fishCloneDeps) {
    const cloneMatch = CLONE_PATH_RE.exec(url.pathname);
    if (cloneMatch) {
      // Gate FIRST — a disabled clone route goes dark (404) regardless of
      // auth, matching the browse routes' behavior. Runs before authorize so
      // an unauthenticated POST to a disabled route 404s, never 401.
      if (!fishCloneDeps.fishBrowseEnabled) {
        return new Response("Not Found", { status: HTTP_NOT_FOUND });
      }
      return dispatchClone(deps, fishCloneDeps, cloneMatch[1] ?? "", request);
    }
  }

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const auth = await authorize(deps, request);
  if (!auth.ok) return auth.response;

  if (url.pathname === PATH_MODELS) {
    return respondModels(await deps.listModels());
  }
  // Fish voice-library browse — self-contained mount, trivially removable.
  if (deps.fishDeps && (url.pathname === FISH_VOICES_PATH || VOICE_ID_SUBPATH.test(url.pathname))) {
    return handleFishBrowse(deps.fishDeps, request);
  }
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

async function dispatchClone(
  deps: ProvidersHandlerDeps,
  fishCloneDeps: FishCloneDeps,
  rawId: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const auth = await authorize(deps, request);
  if (!auth.ok) return auth.response;

  // Fish ids are opaque (not our slug/hex voiceId shape) and only ever flow
  // to fetchFishVoiceById (URL-encoded there), never to a filesystem path —
  // so the VOICE_ID_SHAPE_RE traversal guard voices.ts applies to its ids
  // doesn't apply here; just reject empty / decode-failure.
  const fishVoiceId = safeDecode(rawId);
  if (!fishVoiceId) {
    log.warn("clone.invalid-id-encoding", {});
    return jsonError(HTTP_UNPROCESSABLE, "invalid-voice-id");
  }
  return handleFishClone(fishCloneDeps, auth.userId, fishVoiceId, request);
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

function respondModels(result: ProvidersListResult<ModelEntry[]>): Response {
  if (!result.ok) {
    log.warn("providers.upstream-unavailable", { key: "models", kind: result.error.kind });
    return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
  }
  const stale = result.stale ?? false;
  log.info("providers.list", { key: "models", stale });
  return Response.json({ models: result.value, stale }, { status: HTTP_OK });
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

/** decodeURIComponent throws on malformed percent-encoding (e.g. `%ZZ`) — return
 *  null instead so the caller degrades to a clean 422 rather than an unhandled 500. */
function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
