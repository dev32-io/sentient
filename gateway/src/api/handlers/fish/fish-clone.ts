/**
 * Clone-from-Fish endpoint.
 *
 * Downloads a Fish Audio voice's preview sample and creates a
 * local-tts voice pack from it, then activates it for the caller.
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
import { normalizeLanguage } from "@sentient/config";
import { getLog } from "../../../logging/logger.js";
import type { ProfileStore } from "../../../profile-store/profile-store.js";
import type { FishFetchConfig } from "../../../providers/fish/fish-fetcher.js";
import { fetchFishVoiceById } from "../../../providers/fish/fish-fetcher.js";
import {
  type VoiceMgmtConfig,
  type VoiceMgmtSocketFactory,
  createVoice,
} from "../../../providers/tts/voice-mgmt-client.js";
import { clampTags, truncateField } from "../field-limits.js";
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

// SSRF allowlist. A PUBLIC Fish voice's `samples[].audio` URL is
// attacker-controllable, and the gateway fetches it server-side — so a
// malicious voice could point it at an internal host (localhost, RFC-1918,
// link-local metadata) to exfiltrate. Fish serves preview samples from
// Cloudflare R2 (`<hash>.r2.cloudflarestorage.com`, and browse uses
// `platform.r2.fish.audio`) plus its own `*.fish.audio`, so a host is
// accepted iff it equals or is a subdomain of one of these suffixes. Those
// are public CDN domains — internal/loopback/link-local/RFC-1918 targets
// never resolve under them, which is the SSRF protection that matters for a
// self-hosted deploy.
const ALLOWED_SAMPLE_HOST_SUFFIXES = ["fish.audio", "r2.cloudflarestorage.com"] as const;

// Only https preview URLs are dialed — Fish's CDN is https, and cleartext
// http would let a downgrade/MITM point the download elsewhere.
const HTTPS_PROTOCOL = "https:";

// 3xx status range — with `redirect: "manual"` a redirect is treated as a
// download failure (never followed) so an allowlisted host can't bounce us to
// an internal target.
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 400;

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
  language: string;
}

type BodyResult = { ok: true; value: CloneBody } | { ok: false; error: string };
type FishLookupResult = { ok: true; previewAudioUrl: string } | { ok: false; response: Response };
type DownloadResult = { ok: true; value: ArrayBuffer } | { ok: false };
type HostCheck = { ok: true } | { ok: false; host: string };

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

  // SSRF guard BEFORE the download — reject any host outside the fish.audio
  // allowlist so an attacker-controlled preview URL can't make the gateway
  // dial an internal service.
  const hostCheck = checkSampleHost(fishVoice.previewAudioUrl);
  if (!hostCheck.ok) {
    log.warn("clone.preview-host-not-allowed", { userId, fishVoiceId, host: hostCheck.host });
    return jsonError(HTTP_BAD_GATEWAY, "preview-host-not-allowed");
  }

  const sample = await downloadSample(deps, fishVoice.previewAudioUrl);
  if (!sample.ok) {
    log.warn("clone.preview-download-failed", { userId, fishVoiceId });
    return jsonError(HTTP_BAD_GATEWAY, "preview-download-failed");
  }

  return createAndActivate(deps, userId, fishVoiceId, body.value, sample.value, request.signal);
}

/** SSRF allowlist check: the preview host must be fish.audio or a subdomain.
 *  On reject, returns the rejected host's registrable-ish part (last two
 *  dot-labels) for the log — never the full attacker URL (path/query). */
function checkSampleHost(url: string): HostCheck {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, host: "unparseable" };
  }
  const hostname = parsed.hostname.toLowerCase();
  // Require https BEFORE the suffix check — a cleartext http URL is rejected
  // even on an allowlisted host.
  if (parsed.protocol !== HTTPS_PROTOCOL) return { ok: false, host: hostname };
  const allowed = ALLOWED_SAMPLE_HOST_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`));
  if (allowed) return { ok: true };
  return { ok: false, host: hostname.split(".").slice(-2).join(".") };
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
    // `redirect: "manual"` so an allowlisted host can't 3xx-redirect us to an
    // internal address behind checkSampleHost's back (SSRF). Fish's presigned
    // R2 URLs are direct 200s, so any 3xx here is treated as a download
    // failure rather than followed.
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(deps.externalFetchTimeoutMs),
      redirect: "manual",
    });
    if (isRedirect(resp.status) || !resp.ok) return { ok: false };
    return { ok: true, value: await resp.arrayBuffer() };
  } catch {
    return { ok: false };
  }
}

function isRedirect(status: number): boolean {
  return status >= HTTP_REDIRECT_MIN && status < HTTP_REDIRECT_MAX;
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
  const created = await createVoice(
    buildVoiceCfg(deps),
    body.name,
    sample,
    signal,
    body.description,
    body.tags,
    body.language,
  );
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

/** Exported for direct unit-testing of body validation (see fish-clone.test.ts). */
export async function parseBody(deps: FishCloneDeps, request: Request): Promise<BodyResult> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "malformed json body" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "invalid body" };
  const input = raw as Record<string, unknown>;

  const nameTrimmed = typeof input.name === "string" ? input.name.trim() : "";
  if (!nameTrimmed) return { ok: false, error: "name is required" };
  const name = truncateField(nameTrimmed, VOICE_NAME_MAX_LEN);

  // Auto-imported from the Fish voice — length-capped fields truncate rather
  // than reject (see field-limits.ts) so a long Fish blurb or extra tags never
  // block the clone. Only a malformed tags TYPE is a hard error.
  const description = truncateField(
    typeof input.description === "string" ? input.description.trim() : "",
    deps.descriptionMaxLen,
  );

  const rawTags = extractTags(input.tags);
  if (!rawTags.ok) return rawTags;
  const tags = clampTags(rawTags.value, deps.maxTags, deps.tagMaxLen);

  // Normalized against the Qwen language list — unsupported/absent drops to
  // "" (never rejected), same treatment as parseCreateForm's `language`.
  const language = normalizeLanguage(typeof input.language === "string" ? input.language.trim() : "");
  return { ok: true, value: { name, description, tags, language } };
}

/** Extracts a string tag list from the raw body value — a wrong TYPE is a hard
 *  error (structural), but count/length overflow is handled by clampTags. */
function extractTags(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "tags must be an array" };

  const tags = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
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
