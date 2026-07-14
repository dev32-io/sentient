import type { Result } from "@sentient/protocol";
import { getLog } from "../../logging/logger.js";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";
import {
  type VoiceMgmtConfig,
  type VoiceMgmtSocketFactory,
  type VoiceOpError,
  createVoice,
  deleteVoice,
  listVoices,
} from "../../providers/tts/voice-mgmt-client.js";
import type { TokenService } from "../../user-auth/token-service.js";

const log = getLog(["sentient", "gateway", "api", "voices"]);

// ---------------------------------------------------------------------------
// AUTHORIZATION MODEL — intentional shared household voice library.
//
// Voice packs live in the single, gateway-wide ChatterboxTTS voice store; they
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

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_UNPROCESSABLE = 422;
const HTTP_BAD_GATEWAY = 502;
const HTTP_TIMEOUT = 504;

// Warning codes surfaced on an otherwise-200 body when the TTS service already
// committed the irreversible primary op (create under the synth lock / delete)
// but a secondary LOCAL profile read/save failed. The voiceId is never dropped
// in this case — see handleVoicesPost / handleVoicesDelete.
const WARNING_NOT_ACTIVATED = "not-activated";
const WARNING_PROFILE_NOT_UPDATED = "profile-not-updated";

// Reset target when the deleted voice was the caller's active pick — mirrors
// cfg.tts.voice_id's "default" sentinel (falls back to the model's built-in
// default voice at synthesis time; see local-tts-protocol's connect-URL doc).
const DEFAULT_VOICE_ID = "default";
const VOICE_NAME_MAX_LEN = 64;
const VOICE_ID_SHAPE_RE = /^[0-9a-f]{32}$/;
const VOICE_ID_PATH_RE = /^\/api\/v1\/voices\/([^/]+)$/;

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

  const idMatch = VOICE_ID_PATH_RE.exec(pathname);
  if (idMatch) return dispatchVoiceId(deps, request, userId, decodeURIComponent(idMatch[1] ?? ""));

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
  const parsed = await parseCreateForm(request);
  if (!parsed.ok) {
    log.warn("create.invalid-request", { userId, reason: parsed.error });
    return jsonError(HTTP_UNPROCESSABLE, "invalid-request", parsed.error);
  }

  const audio = await parsed.value.audio.arrayBuffer();
  const result = await createVoice(buildCfg(deps), parsed.value.name, audio, request.signal);
  if (!result.ok) return mapVoiceOpError(result.error);

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

/** Sets `profile.voice = {provider:"local-tts", id: voiceId}` and live-propagates it.
 *  Creating a voice activates it — the plan's stated contract. */
async function activateVoice(deps: VoicesHandlerDeps, userId: string, voiceId: string): Promise<Result<void, string>> {
  return writeVoiceId(deps, userId, voiceId);
}

/** Resets `profile.voice.id` to "default" ONLY when the deleted id was the
 *  caller's current active voice. No profile write otherwise — deleting an
 *  inactive pack must not disturb the active pick. */
async function deactivateIfActive(
  deps: VoicesHandlerDeps,
  userId: string,
  deletedVoiceId: string,
): Promise<Result<void, string>> {
  const got = await deps.profileStore.get(userId);
  if (!got.ok) {
    // The service-side deletion already succeeded (idempotent op); a failed
    // profile read here means we can't tell whether a reset is owed, not
    // that the delete itself failed. Log and don't fail the whole request.
    log.warn("delete.profile-read-failed", { userId, reason: got.error });
    return { ok: true, value: undefined };
  }
  if (got.value.voice.id !== deletedVoiceId) return { ok: true, value: undefined };
  return writeVoiceId(deps, userId, DEFAULT_VOICE_ID);
}

async function writeVoiceId(deps: VoicesHandlerDeps, userId: string, voiceId: string): Promise<Result<void, string>> {
  const got = await deps.profileStore.get(userId);
  if (!got.ok) return mapProfileStoreError(got.error);

  const updated: ProfileV1 = { ...got.value, voice: { provider: "local-tts", id: voiceId } };
  const saved = await deps.profileStore.save(updated);
  if (!saved.ok) return mapProfileStoreError(saved.error);

  await deps.refreshVoice(userId);
  return { ok: true, value: undefined };
}

function mapProfileStoreError(error: ProfileStoreError): Result<void, string> {
  return { ok: false, error };
}

interface CreateFormInput {
  readonly name: string;
  readonly audio: Blob;
}

async function parseCreateForm(request: Request): Promise<Result<CreateFormInput, string>> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, error: "malformed multipart body" };
  }

  const nameRaw = form.get("name");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > VOICE_NAME_MAX_LEN) return { ok: false, error: `name exceeds ${VOICE_NAME_MAX_LEN} chars` };

  const audio = form.get("audio");
  if (!(audio instanceof Blob)) return { ok: false, error: "audio file is required" };

  return { ok: true, value: { name, audio } };
}

function buildCfg(deps: VoicesHandlerDeps): VoiceMgmtConfig {
  return {
    url: deps.ttsUrl,
    connectTimeoutMs: deps.connectTimeoutMs,
    opTimeoutMs: deps.opTimeoutMs,
    ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
  };
}

function mapVoiceOpError(error: VoiceOpError): Response {
  switch (error.kind) {
    case "service-error":
      return Response.json({ error: "voice-op-failed", reason: error.reason }, { status: HTTP_UNPROCESSABLE });
    case "timeout":
      return jsonError(HTTP_TIMEOUT, "voice-op-timeout");
    case "transport":
      return jsonError(HTTP_BAD_GATEWAY, "tts-unreachable");
    default:
      return assertNever(error);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function jsonError(status: number, code: string, reason?: string): Response {
  return Response.json(reason !== undefined ? { error: code, reason } : { error: code }, { status });
}
