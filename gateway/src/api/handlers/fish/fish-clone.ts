/**
 * Clone-from-Fish endpoint.
 *
 * Downloads a Fish Audio voice's preview sample and creates a local
 * Chatterbox voice pack from it, then activates it for the caller.
 *
 * Self-contained, removable module — mirrors gateway/src/api/handlers/fish/
 * fish-browse.ts. `handleFishClone` is the only export the providers handler
 * imports; deleting this file + its one mount block in providers.ts fully
 * removes the feature.
 *
 * Unlike fish-browse.ts's self-contained `authorize()`, this handler does NOT
 * re-check the bearer token itself: it needs the caller's resolved userId for
 * `activateVoice` regardless, so the mount (providers.ts) authenticates once
 * and passes userId straight through.
 */
import { getLog } from "../../../logging/logger.js";
import type { ProfileStore } from "../../../profile-store/profile-store.js";
import type { FishFetchConfig } from "../../../providers/fish/fish-fetcher.js";
import { fetchFishVoiceById } from "../../../providers/fish/fish-fetcher.js";
import {
  type VoiceMgmtConfig,
  type VoiceMgmtSocketFactory,
  createVoice,
} from "../../../providers/tts/voice-mgmt-client.js";
import { VOICE_NAME_MAX_LEN } from "../voices-create-form.js";
import {
  HTTP_BAD_GATEWAY,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNPROCESSABLE,
  jsonError,
  mapVoiceOpError,
} from "../voices-http.js";
import { activateVoice } from "../voices-profile-sync.js";

const log = getLog(["sentient", "api", "fish", "clone"]);

const WARNING_NOT_ACTIVATED = "not-activated";

export interface FishCloneFetchers {
  /** Tests inject a fake; production uses fetchFishVoiceById directly. */
  fishById?: typeof fetchFishVoiceById;
}

export interface FishCloneDeps {
  fishBrowseEnabled: boolean;
  fishApiKey: string | null;
  /** Bounds both the Fish `/model/:id` lookup and the mp3 sample download. */
  externalFetchTimeoutMs: number;
  profileStore: ProfileStore;
  /** Re-applies the per-user voice to the live PersonSession after activation. */
  refreshVoice: (userId: string) => Promise<void>;
  ttsUrl: string;
  connectTimeoutMs: number;
  opTimeoutMs: number;
  /** create description char cap (services.ttsConfig.voice_description_max_len). */
  descriptionMaxLen: number;
  /** Per-tag char cap (services.ttsConfig.voice_tag_max_len). */
  tagMaxLen: number;
  /** Max tag count per voice (services.ttsConfig.voice_max_tags). */
  maxTags: number;
  /** Production uses the global WebSocket; tests inject a fake. */
  socketFactory?: VoiceMgmtSocketFactory;
  fetchers?: FishCloneFetchers;
}

interface CloneBody {
  name: string;
  description: string;
  tags: string[];
}

type BodyResult = { ok: true; value: CloneBody } | { ok: false; error: string };
type FishLookupResult = { ok: true; previewAudioUrl: string } | { ok: false; response: Response };
type DownloadResult = { ok: true; value: ArrayBuffer } | { ok: false };

export async function handleFishClone(
  deps: FishCloneDeps,
  userId: string,
  fishVoiceId: string,
  request: Request,
): Promise<Response> {
  if (!deps.fishBrowseEnabled) {
    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  }

  const body = await parseBody(deps, request);
  if (!body.ok) {
    log.warn("clone.invalid-request", { userId, fishVoiceId, reason: body.error });
    return jsonError(HTTP_UNPROCESSABLE, "invalid-request", body.error);
  }

  const fishVoice = await lookupFishVoice(deps, fishVoiceId);
  if (!fishVoice.ok) return fishVoice.response;

  const sample = await downloadSample(deps, fishVoice.previewAudioUrl);
  if (!sample.ok) {
    log.warn("clone.preview-download-failed", { userId, fishVoiceId });
    return jsonError(HTTP_BAD_GATEWAY, "preview-download-failed");
  }

  return createAndActivate(deps, userId, fishVoiceId, body.value, sample.value, request.signal);
}

async function lookupFishVoice(deps: FishCloneDeps, fishVoiceId: string): Promise<FishLookupResult> {
  const fetchById = deps.fetchers?.fishById ?? fetchFishVoiceById;
  const result = await fetchById(fishConfig(deps), fishVoiceId);
  if (!result.ok) {
    if (result.error.kind === "not-found") {
      log.info("clone.fish-not-found", { fishVoiceId });
      return { ok: false, response: jsonError(HTTP_NOT_FOUND, "voice-not-found") };
    }
    log.warn("clone.fish-upstream-failed", { fishVoiceId, kind: result.error.kind });
    return { ok: false, response: jsonError(HTTP_BAD_GATEWAY, "upstream-unavailable") };
  }

  const { previewAudioUrl } = result.value;
  if (!previewAudioUrl) {
    log.warn("clone.no-preview-sample", { fishVoiceId });
    return { ok: false, response: jsonError(HTTP_UNPROCESSABLE, "no-preview-sample") };
  }
  return { ok: true, previewAudioUrl };
}

async function downloadSample(deps: FishCloneDeps, url: string): Promise<DownloadResult> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(deps.externalFetchTimeoutMs) });
    if (!resp.ok) return { ok: false };
    return { ok: true, value: await resp.arrayBuffer() };
  } catch {
    return { ok: false };
  }
}

async function createAndActivate(
  deps: FishCloneDeps,
  userId: string,
  fishVoiceId: string,
  body: CloneBody,
  sample: ArrayBuffer,
  signal: AbortSignal,
): Promise<Response> {
  log.info("clone.create.request", { userId, fishVoiceId, bytes: sample.byteLength, tagCount: body.tags.length });
  const created = await createVoice(buildVoiceCfg(deps), body.name, sample, signal, body.description, body.tags);
  if (!created.ok) {
    log.warn("clone.create.failed", { userId, fishVoiceId, kind: created.error.kind });
    return mapVoiceOpError(created.error);
  }

  const { voiceId, name } = created.value;
  const activated = await activateVoice(deps, userId, voiceId);
  if (!activated.ok) {
    // The pack already exists on the service (storage consumed under the synth
    // lock) — a failed local activation write must never drop the voiceId or
    // report total failure. Mirrors handleVoicesPost's identical invariant.
    log.warn("clone.activate-failed", { userId, fishVoiceId, voiceId });
    return Response.json({ voiceId, name, warning: WARNING_NOT_ACTIVATED }, { status: HTTP_OK });
  }
  log.info("clone.success", { userId, fishVoiceId, voiceId });
  return Response.json({ voiceId, name }, { status: HTTP_OK });
}

async function parseBody(deps: FishCloneDeps, request: Request): Promise<BodyResult> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "malformed json body" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "invalid body" };
  const input = raw as Record<string, unknown>;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > VOICE_NAME_MAX_LEN) return { ok: false, error: `name exceeds ${VOICE_NAME_MAX_LEN} chars` };

  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > deps.descriptionMaxLen) {
    return { ok: false, error: `description exceeds ${deps.descriptionMaxLen} chars` };
  }

  const tags = parseTags(deps, input.tags);
  if (!tags.ok) return tags;
  return { ok: true, value: { name, description, tags: tags.value } };
}

function parseTags(deps: FishCloneDeps, raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "tags must be an array" };

  const tags = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length > deps.maxTags) return { ok: false, error: `too many tags (max ${deps.maxTags})` };
  if (tags.some((t) => t.length > deps.tagMaxLen)) return { ok: false, error: `tag exceeds ${deps.tagMaxLen} chars` };
  return { ok: true, value: tags };
}

function fishConfig(deps: FishCloneDeps): FishFetchConfig {
  return { apiKey: deps.fishApiKey, timeoutMs: deps.externalFetchTimeoutMs };
}

function buildVoiceCfg(deps: FishCloneDeps): VoiceMgmtConfig {
  return {
    url: deps.ttsUrl,
    connectTimeoutMs: deps.connectTimeoutMs,
    opTimeoutMs: deps.opTimeoutMs,
    ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
  };
}
