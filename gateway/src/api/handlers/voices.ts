import type { Result } from "@sentient/protocol";
import { getLog } from "../../logging/logger.js";
import type { ProfileStore } from "../../profile-store/profile-store.js";
import {
  type VoiceMgmtConfig,
  type VoiceMgmtSocketFactory,
  createVoice,
  deleteVoice,
  listVoices,
} from "../../providers/tts/voice-mgmt-client.js";
import type { TokenService } from "../../user-auth/token-service.js";
import { type CreateFormInput, parseCreateForm } from "./voices-create-form.js";
import {
  HTTP_METHOD,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  jsonError,
  mapVoiceOpError,
} from "./voices-http.js";
import { handleVoicesPreview } from "./voices-preview.js";
import { activateVoice, deactivateIfActive } from "./voices-profile-sync.js";

const log = getLog(["sentient", "gateway", "api", "voices"]);

// ---------------------------------------------------------------------------
// AUTHORIZATION MODEL — intentional shared household voice library.
//
// Voice packs live in the single, gateway-wide local-tts voice store; they
// are NOT scoped per user. Any authenticated household member can create, list,
// select, and delete any voice. This is a deliberate product decision, not an
// IDOR oversight: a family shares one gateway, and a voice one member clones is
// meant to be usable by everyone ("Dad adds his voice, the kids can pick it").
// The trust boundary is the household (all members are authenticated family),
// not the individual user.
//
// Consequence of shared delete: deleting a pack that ANOTHER member had active
// leaves that member's profile.voice.id pointing at a now-gone id. This
// degrades gracefully — the service's get_or_default() resolves an unknown id
// to the built-in default voice (no error), so their next reply simply uses the
// default until they pick again. Only the CALLER's own profile is reset on
// delete (see handleVoicesDelete); other members are not rewritten.
//
// A push security sweep flagged the missing per-user ownership check (MEDIUM
// IDOR); resolved as by-design after confirming the shared-library intent.
// ---------------------------------------------------------------------------

// Warning codes surfaced on an otherwise-200 body when the TTS service already
// committed the irreversible primary op (create under the synth lock / delete)
// but a secondary LOCAL profile read/save failed. The voiceId is never dropped
// in this case — see handleVoicesPost / handleVoicesDelete.
const WARNING_NOT_ACTIVATED = "not-activated";
const WARNING_PROFILE_NOT_UPDATED = "profile-not-updated";

// Hex (a service-generated user voiceId, 32 chars) OR a lowercase slug (a
// built-in voice's id, e.g. "nova") — widened from hex-only so DELETE can
// reach a built-in id and mapVoiceOpError can surface the service's real
// 409 builtin-voice rejection instead of a pre-service 422. Still blocks
// traversal / injection shapes: no ".", "/", uppercase, or unicode.
const VOICE_ID_SHAPE_RE = /^[a-z0-9-]{1,32}$/;
const VOICE_ID_PATH_RE = /^\/api\/v1\/voices\/([^/]+)$/;
const VOICE_PREVIEW_PATH_RE = /^\/api\/v1\/voices\/([^/]+)\/preview$/;

export interface VoicesHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  profileStore: ProfileStore;
  /** Re-applies the per-user voice to the live PersonSession — see profile.ts's
   *  identical dep. Called after every `voice.id`-changing write so a
   *  create/delete takes effect on the next TTS turn without a restart. */
  refreshVoice: (userId: string) => Promise<void>;
  ttsUrl: string;
  connectTimeoutMs: number;
  opTimeoutMs: number;
  /** Configured pool of short greeting lines — POST .../preview picks one at
   *  random and synthesizes it live in the target voice. */
  previewGreetings: readonly string[];
  /** Max ms to await a preview synth reply. Separate from opTimeoutMs: a full
   *  TTS render legitimately runs longer than a voice.create/list/delete
   *  control round-trip. */
  previewTimeoutMs: number;
  /** create/edit description char cap (services.ttsConfig.voice_description_max_len). */
  descriptionMaxLen: number;
  /** Per-tag char cap (services.ttsConfig.voice_tag_max_len). */
  tagMaxLen: number;
  /** Max tag count per voice (services.ttsConfig.voice_max_tags). */
  maxTags: number;
  /** Production uses the global WebSocket; tests inject a fake. */
  socketFactory?: VoiceMgmtSocketFactory;
}

export function createVoicesHandler(deps: VoicesHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => handleVoices(deps, request);
}

async function handleVoices(deps: VoicesHandlerDeps, request: Request): Promise<Response> {
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("token-rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }
  const userId = valid.value.userId;
  const { pathname } = new URL(request.url);

  if (pathname === "/api/v1/voices") return dispatchCollection(deps, request, userId);

  const previewMatch = VOICE_PREVIEW_PATH_RE.exec(pathname);
  if (previewMatch) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: HTTP_METHOD });
    // Same shape guard the DELETE path enforces — the `([^/]+)` group can match
    // an encoded-traversal shape (`..%2Fsecret`), so decode-then-validate BEFORE
    // reaching the service. A malformed percent-encoding (`%ZZ`) throws in
    // decodeURIComponent — catch it to a clean 422 rather than an unhandled 500.
    const voiceId = safeDecode(previewMatch[1] ?? "");
    if (voiceId === null || !VOICE_ID_SHAPE_RE.test(voiceId)) {
      log.warn("preview.invalid-id-shape", {});
      return jsonError(HTTP_UNPROCESSABLE, "invalid-voice-id");
    }
    return handleVoicesPreview(deps, voiceId, request.signal);
  }

  const idMatch = VOICE_ID_PATH_RE.exec(pathname);
  if (idMatch) {
    // Symmetry with the preview branch: a malformed percent-encoding (`%ZZ`)
    // throws in decodeURIComponent — degrade to a clean 422 rather than let it
    // bubble to Bun.serve's top-level handler as a generic 500. The
    // VOICE_ID_SHAPE_RE check still runs downstream in handleVoicesDelete.
    const voiceId = safeDecode(idMatch[1] ?? "");
    if (voiceId === null) {
      log.warn("delete.invalid-id-encoding", {});
      return jsonError(HTTP_UNPROCESSABLE, "invalid-voice-id");
    }
    return dispatchVoiceId(deps, request, userId, voiceId);
  }

  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

function dispatchCollection(deps: VoicesHandlerDeps, request: Request, userId: string): Promise<Response> {
  if (request.method === "GET") return handleVoicesGet(deps, userId, request.signal);
  if (request.method === "POST") return handleVoicesPost(deps, userId, request);
  return Promise.resolve(new Response("Method Not Allowed", { status: HTTP_METHOD }));
}

function dispatchVoiceId(
  deps: VoicesHandlerDeps,
  request: Request,
  userId: string,
  voiceId: string,
): Promise<Response> {
  if (request.method !== "DELETE") {
    return Promise.resolve(new Response("Method Not Allowed", { status: HTTP_METHOD }));
  }
  return handleVoicesDelete(deps, userId, voiceId, request.signal);
}

async function handleVoicesGet(deps: VoicesHandlerDeps, userId: string, signal: AbortSignal): Promise<Response> {
  log.info("list.request", { userId });
  const result = await listVoices(buildCfg(deps), signal);
  if (!result.ok) return mapVoiceOpError(result.error);
  return Response.json({ voices: result.value.voices }, { status: HTTP_OK });
}

async function handleVoicesPost(deps: VoicesHandlerDeps, userId: string, request: Request): Promise<Response> {
  const parsed: Result<CreateFormInput, string> = await parseCreateForm(deps, request);
  if (!parsed.ok) {
    log.warn("create.invalid-request", { userId, reason: parsed.error });
    return jsonError(HTTP_UNPROCESSABLE, "invalid-request", parsed.error);
  }

  // Boundary log for the request about to be dispatched to the TTS service —
  // sizes/counts only, never the name/description/tag content (log-sanitizer
  // rule). Placed post-parse (mirrors preview.request's placement after its
  // own local greeting pick) so it carries real byteLength/tagCount instead
  // of firing blind before the body is even read.
  log.info("create.request", { userId, audioBytes: parsed.value.audio.size, tagCount: parsed.value.tags.length });

  const audio = await parsed.value.audio.arrayBuffer();
  const result = await createVoice(
    buildCfg(deps),
    parsed.value.name,
    audio,
    request.signal,
    parsed.value.description,
    parsed.value.tags,
    parsed.value.language,
  );
  if (!result.ok) {
    const reason = result.error.kind === "service-error" ? result.error.reason : undefined;
    log.warn("create.failed", { userId, kind: result.error.kind, ...(reason !== undefined ? { reason } : {}) });
    return mapVoiceOpError(result.error);
  }

  const { voiceId, name } = result.value;
  const activated = await activateVoice(deps, userId, voiceId);
  if (!activated.ok) {
    // The pack already exists on the service (storage consumed under the synth
    // lock) — a failed local activation write must never drop the voiceId or
    // report total failure. The id still surfaces via GET and can be activated
    // later through PUT /api/v1/profile/me.
    log.warn("create.activate-failed", { userId, voiceId, reason: activated.error });
    return Response.json({ voiceId, name, warning: WARNING_NOT_ACTIVATED }, { status: HTTP_OK });
  }
  log.info("create.success", { userId, voiceId });
  return Response.json({ voiceId, name }, { status: HTTP_OK });
}

async function handleVoicesDelete(
  deps: VoicesHandlerDeps,
  userId: string,
  voiceId: string,
  signal: AbortSignal,
): Promise<Response> {
  if (!VOICE_ID_SHAPE_RE.test(voiceId)) {
    log.warn("delete.invalid-id-shape", { userId });
    return jsonError(HTTP_UNPROCESSABLE, "invalid-voice-id");
  }

  const result = await deleteVoice(buildCfg(deps), voiceId, signal);
  if (!result.ok) return mapVoiceOpError(result.error);

  const deactivated = await deactivateIfActive(deps, userId, voiceId);
  if (!deactivated.ok) {
    // The service-side delete already committed (and is idempotent) — a failed
    // local profile reset must never surface as a 500. The dangling
    // profile.voice.id is a future-webui prompt-to-fix concern, not a request
    // failure.
    log.warn("delete.deactivate-save-failed", { userId, voiceId, reason: deactivated.error });
    return Response.json({ voiceId, warning: WARNING_PROFILE_NOT_UPDATED }, { status: HTTP_OK });
  }
  log.info("delete.success", { userId, voiceId });
  return Response.json({ voiceId }, { status: HTTP_OK });
}

function buildCfg(deps: VoicesHandlerDeps): VoiceMgmtConfig {
  return {
    url: deps.ttsUrl,
    connectTimeoutMs: deps.connectTimeoutMs,
    opTimeoutMs: deps.opTimeoutMs,
    ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
  };
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
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
