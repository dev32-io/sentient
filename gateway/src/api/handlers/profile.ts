import type { McpCatalog, ToolPermissionMap } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import type { ApplyError, ApplyOutcome } from "../../apply/orchestrator.js";
import { getLog } from "../../logging/logger.js";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import { type ProfileV1, profileV1Schema } from "../../profile-store/profile-types.js";
import {
  type ProfileUpdateBase,
  applyProfileUpdate,
  seedsPermissionDefaults,
} from "../../profile-store/profile-update.js";
import { defaultPermissionsFor } from "../../tools/role-defaults.js";
import type { TokenService } from "../../user-auth/token-service.js";
import type { UserStore } from "../../user-auth/user-store.js";

const log = getLog(["sentient", "gateway", "api", "profile"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_TOO_MANY = 429;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL = 500;

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
  /** The account's ROLE, read from its record at save time. The token names a
   *  user and carries no authority, so the role a new permission table is
   *  seeded for is resolved here, on this request, from the record. */
  users: Pick<UserStore, "get">;
  /** `config.yaml#mcp_catalog` — which tools exist and what tier each carries.
   *  Seeding a profile that has never had a table needs both this and the
   *  role. */
  mcpCatalog: McpCatalog;
  runApply: (userId: string) => Promise<Result<ApplyOutcome, ApplyError>>;
  /** Phase D delegate — handles `/soul`, `/personalities*`, `/active-personality`. */
  handleEdit: (request: Request) => Promise<Response>;
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

  const parsedOrError = await parseProfileBody(request, userId);
  if (parsedOrError instanceof Response) return parsedOrError;

  const storedOrError = await readStoredProfile(deps, userId);
  if (storedOrError instanceof Response) return storedOrError;

  const base: ProfileUpdateBase = {
    stored: storedOrError,
    permissionDefaults: await resolveRoleTemplate(deps, userId),
  };
  if (seedsPermissionDefaults(base)) {
    log.info("me.put-seeded-permissions", {
      userId,
      reason: "the stored profile carried no permission table",
    });
  }
  const toSave = applyProfileUpdate(parsedOrError, base);

  const saveResult = await deps.profileStore.save(toSave);
  if (!saveResult.ok) {
    log.warn("me.put-save-failed", { userId, reason: saveResult.error });
    return jsonError(HTTP_INTERNAL, saveResult.error);
  }

  return Response.json(toSave, { status: HTTP_OK });
}

async function parseProfileBody(request: Request, userId: string): Promise<ProfileV1 | Response> {
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
  return parsed.data;
}

/**
 * The profile this PUT is a delta against, or `undefined` when there genuinely
 * is not one yet.
 *
 * A READ FAILURE IS NOT AN EMPTY PROFILE. Merging onto `undefined` keeps only
 * what the body names, so treating an unreadable profile as "nothing stored"
 * would delete every permission the person set from a window this process
 * happens not to be able to read right now. `not-found` is the one error class
 * that really does mean nothing is stored.
 */
async function readStoredProfile(deps: ProfileHandlerDeps, userId: string): Promise<ProfileV1 | undefined | Response> {
  const stored = await deps.profileStore.get(userId);
  if (stored.ok) return stored.value;
  if (isAbsentProfile(stored.error)) {
    log.info("me.put-no-stored-profile", { userId, reason: stored.error });
    return undefined;
  }
  log.warn("me.put-stored-unreadable", {
    userId,
    reason: stored.error,
    outcome: "refused",
    detail: "a settings table may exist that this read cannot see — saving would overwrite it with a partial one",
  });
  return jsonError(HTTP_INTERNAL, stored.error);
}

/** EXHAUSTIVE over `ProfileStoreError`, no `default:` arm — a new error class
 *  must be classified as "nothing was ever stored" or "something is stored and
 *  I cannot see it" by whoever adds it, never inherit one by accident. Mirrors
 *  `tools/user-tool-permissions.ts`, which classifies the same four for the
 *  same reason. */
function isAbsentProfile(error: ProfileStoreError): boolean {
  switch (error) {
    case "not-found":
      return true;
    case "corrupt-file":
      return false;
    case "io-error":
      return false;
    case "validation-error":
      return false;
  }
}

/**
 * The account's per-role starter table — what `applyProfileUpdate` seeds a
 * never-tabled profile from. `undefined` when the role cannot be read.
 *
 * A ROLE WE CANNOT READ IS NOT FATAL. Seeding repairs an incomplete profile; it
 * grants nothing that was not already the account's default, so skipping it
 * leaves the profile exactly as complete as it already was. Refusing the whole
 * save would instead cost the person the voice change they came here to make,
 * for a reason that has nothing to do with it.
 *
 * Only PERMISSIONS are seeded here, deliberately — not `applyProfileDefaults`,
 * which also refills `tools.toolsets` whenever it is empty. An empty toolsets
 * list is legal and meaningful ("no built-ins, MCP-only", see profile-types.ts),
 * so refilling it on a save would silently hand four Hermes toolsets back to
 * somebody who had just turned them all off — the same asymmetry the empty
 * permission table is careful about.
 */
async function resolveRoleTemplate(deps: ProfileHandlerDeps, userId: string): Promise<ToolPermissionMap | undefined> {
  const record = await deps.users.get(userId);
  if (!record.ok || record.value === null) {
    log.warn("me.put-role-unavailable", {
      userId,
      reason: record.ok ? "no-user-record" : record.error,
      outcome: "no-seeding",
      detail: "the account's role decides its default permission table and could not be read",
    });
    return undefined;
  }
  return defaultPermissionsFor(record.value.role, deps.mcpCatalog);
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
