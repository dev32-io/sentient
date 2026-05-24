import type { Result } from "@sentient/protocol";
import type { ApplyError, ApplyOutcome } from "../../apply/orchestrator.js";
import { getLog } from "../../logging/logger.js";
import type { ProfileStore } from "../../profile-store/profile-store.js";
import { profileV1Schema } from "../../profile-store/profile-types.js";
import type { TokenService } from "../../user-auth/token-service.js";

const log = getLog(["sentient", "gateway", "api", "profile"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_TOO_MANY = 429;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_TIMEOUT = 504;

// Per-user serialization for apply. Concurrent `POST /api/v1/profile/apply`
// races hit supervisorctl mid-restart (the second request sees the program
// in transitional `stopped` / `ERROR (not running)` state and fails the
// whole apply). The mutex rejects overlapping requests with 429 instead of
// letting them tear at supervisord. Released in a finally so a hung apply
// can't permanently lock a user out.
const inflightApply = new Map<string, Promise<unknown>>();

export interface ProfileHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  profileStore: ProfileStore;
  runApply: (userId: string) => Promise<Result<ApplyOutcome, ApplyError>>;
  /** Phase D delegate — handles `/soul`, `/personalities*`, `/active-personality`. */
  handleEdit: (request: Request) => Promise<Response>;
  /**
   * Re-resolve and apply per-user voiceId on the live PersonSession after a
   * profile.json save. Lets a voice change take effect on the next TTS turn
   * without a Hermes restart. No-op when no PersonSession is bound.
   */
  refreshVoice: (userId: string) => Promise<void>;
}

export function createProfileHandler(deps: ProfileHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => handleProfile(deps, request);
}

async function handleProfile(deps: ProfileHandlerDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/profile/apply") return handleApply(deps, request);
  if (url.pathname === "/api/v1/profile/me") return handleMe(deps, request);
  // Phase D: SOUL + personality endpoints. The delegate runs its own bearer-auth
  // gate so every Phase D path is uniformly authenticated.
  if (
    url.pathname === "/api/v1/profile/soul" ||
    url.pathname === "/api/v1/profile/soul/default" ||
    url.pathname === "/api/v1/profile/memory/memory" ||
    url.pathname === "/api/v1/profile/memory/user" ||
    url.pathname === "/api/v1/profile/personalities" ||
    url.pathname.startsWith("/api/v1/profile/personalities/") ||
    url.pathname === "/api/v1/profile/active-personality"
  ) {
    return deps.handleEdit(request);
  }
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

async function handleApply(deps: ProfileHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("apply.token-rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }

  const userId = valid.value.userId;
  log.info("apply.request", { userId });

  if (inflightApply.has(userId)) {
    log.warn("apply.rejected-concurrent", { userId });
    return Response.json(
      { error: "apply-in-progress", reason: "another apply is already running for this user" },
      { status: HTTP_TOO_MANY },
    );
  }

  const promise = deps.runApply(userId);
  inflightApply.set(userId, promise);
  try {
    const result = await promise;
    if (result.ok) {
      log.info("apply.ready", { userId, elapsedMs: result.value.elapsedMs });
      return Response.json({ status: "ready", elapsedMs: result.value.elapsedMs }, { status: HTTP_OK });
    }
    return mapApplyError(userId, result.error);
  } finally {
    inflightApply.delete(userId);
  }
}

async function handleMe(deps: ProfileHandlerDeps, request: Request): Promise<Response> {
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("me.token-rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }

  const userId = valid.value.userId;

  if (request.method === "GET") return handleMeGet(deps, userId);
  if (request.method === "PUT") return handleMePut(deps, userId, request);
  return new Response("Method Not Allowed", { status: HTTP_METHOD });
}

async function handleMeGet(deps: ProfileHandlerDeps, userId: string): Promise<Response> {
  log.info("me.request", { method: "GET", userId });

  const result = await deps.profileStore.get(userId);
  if (!result.ok) {
    if (result.error === "not-found") {
      // Profile is always created by the provisioner during account setup.
      // A missing profile indicates a corruption case, not a first-read.
      log.warn("me.profile-not-found", { userId });
      return jsonError(HTTP_NOT_FOUND, "profile-not-found");
    }
    log.warn("me.get-failed", { userId, reason: result.error });
    return jsonError(HTTP_INTERNAL, result.error);
  }

  return Response.json(result.value, { status: HTTP_OK });
}

async function handleMePut(deps: ProfileHandlerDeps, userId: string, request: Request): Promise<Response> {
  log.info("me.request", { method: "PUT", userId });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    log.warn("me.put-invalid-json", { userId });
    return jsonError(HTTP_UNPROCESSABLE, "invalid-json");
  }

  const parsed = profileV1Schema.safeParse(raw);
  if (!parsed.success) {
    log.warn("me.put-schema-error", { userId, reason: parsed.error.message });
    return jsonError(HTTP_UNPROCESSABLE, "schema-invalid");
  }

  if (parsed.data.userId !== userId) {
    log.warn("me.put-userid-mismatch", { bearer: userId, body: parsed.data.userId });
    return jsonError(HTTP_UNPROCESSABLE, "userId-mismatch");
  }

  const saveResult = await deps.profileStore.save(parsed.data);
  if (!saveResult.ok) {
    log.warn("me.put-save-failed", { userId, reason: saveResult.error });
    return jsonError(HTTP_INTERNAL, saveResult.error);
  }

  // Live-propagate per-user voice to any attached PersonSession. Voice is
  // gateway-side TTS, not Hermes-side — the apply-restart for Hermes-owned
  // fields is a separate flow; this keeps voice picks effective even when
  // the user doesn't apply (or for the next TTS turn after apply restarts).
  await deps.refreshVoice(userId);

  return Response.json(parsed.data, { status: HTTP_OK });
}

function mapApplyError(userId: string, error: ApplyError): Response {
  log.warn("apply.failed", { userId, kind: error.kind });
  switch (error.kind) {
    case "user-not-found":
      return jsonError(HTTP_NOT_FOUND, "user-not-found");
    case "render-error":
      return Response.json({ error: "render-error", reason: error.reason }, { status: HTTP_UNPROCESSABLE });
    case "write-error":
      return Response.json({ error: "write-error", reason: error.reason }, { status: HTTP_UNPROCESSABLE });
    case "docker-restart-failed":
      return jsonError(HTTP_BAD_GATEWAY, "docker-restart-failed");
    case "health-check-timeout":
      return jsonError(HTTP_TIMEOUT, "health-check-timeout");
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

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}
