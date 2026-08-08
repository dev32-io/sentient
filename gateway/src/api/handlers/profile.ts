import type { McpCatalog, ToolPermissionMap } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import type { ApplyError, ApplyOutcome } from "../../apply/orchestrator.js";
import { getLog } from "../../logging/logger.js";
import { applyProfileDefaults } from "../../profile-store/profile-defaults.js";
import type { ProfileStore, ProfileStoreError } from "../../profile-store/profile-store.js";
import { type ProfileV1, profileV1Schema } from "../../profile-store/profile-types.js";
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

  const merged = mergeIntoStored(parsedOrError, storedOrError);
  const toSave = await seedIfNeverConfigured(deps, userId, merged);

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
 * A PUT REPLACES ONLY THE PERMISSION KEYS IT NAMES.
 *
 * Everything else in the profile is a whole-value field the body always
 * carries (the schema requires model, voice, persona, compression, advanced),
 * so it is replaced outright. `tools.permissions` is the one field a client can
 * legitimately hold an opinion about only PART of, and the difference matters:
 *
 *   - a SERVER the body does not name keeps its stored per-tool map;
 *   - a TOOL the body does not name keeps its stored permission;
 *   - a body with no `permissions` key at all, or an empty one, changes
 *     nothing.
 *
 * WHY A DELTA AND NOT A REPLACEMENT. Every account's table is complete for its
 * role from creation (`applyProfileDefaults`), and the broker resolves it with
 * no fallthrough behind it — so an entry that disappears does not revert to a
 * default, it becomes a tool with no answer. Under replacement, a client that
 * renders four servers and PUTs what it rendered silently deletes the fifth;
 * a client saving a VOICE change with a stale `tools` object silently deletes
 * all of them. Both are one-line client changes away at all times, and neither
 * would look like a bug from the client's side.
 *
 * NOTHING IS LOST BY GIVING UP DELETION: the four permission states already
 * express every intent a client has. "Off" is `"off"` — including
 * `{"*": "off"}` for a whole server — never an absent key. Silence means "no
 * opinion", which is the only thing a partial body can honestly mean.
 */
function mergeIntoStored(incoming: ProfileV1, stored: ProfileV1 | undefined): ProfileV1 {
  const merged = mergePermissions(stored?.tools.permissions, incoming.tools.permissions);
  if (merged === undefined) return incoming;
  return { ...incoming, tools: { ...incoming.tools, permissions: merged } };
}

function mergePermissions(
  stored: ToolPermissionMap | undefined,
  incoming: ToolPermissionMap | undefined,
): ToolPermissionMap | undefined {
  if (stored === undefined) return incoming;
  if (incoming === undefined) return stored;
  const merged: ToolPermissionMap = { ...stored };
  for (const [server, perServer] of Object.entries(incoming)) {
    merged[server] = { ...merged[server], ...perServer };
  }
  return merged;
}

/**
 * Seeds the account's per-role template onto a profile that has never carried a
 * permission table — the backfill for accounts created before tables existed.
 * A table that IS set is never touched: it is the person's, and the role
 * template is a starting point, not an authority above them.
 *
 * A role we cannot read is not fatal. Seeding repairs an incomplete profile; it
 * grants nothing that was not already the account's default, so failing it
 * leaves the profile exactly as complete as it already was. Refusing the whole
 * save would instead cost the person the voice change they came here to make,
 * for a reason that has nothing to do with it.
 */
async function seedIfNeverConfigured(deps: ProfileHandlerDeps, userId: string, profile: ProfileV1): Promise<ProfileV1> {
  if (profile.tools.permissions !== undefined) return profile;

  const record = await deps.users.get(userId);
  if (!record.ok || record.value === null) {
    log.warn("me.put-role-unavailable", {
      userId,
      reason: record.ok ? "no-user-record" : record.error,
      outcome: "saved-unseeded",
      detail: "the account's role decides its default permission table and could not be read",
    });
    return profile;
  }

  log.info("me.put-seeded-permissions", {
    userId,
    role: record.value.role,
    reason: "the stored profile carried no permission table",
  });
  return applyProfileDefaults(profile, { role: record.value.role, mcpCatalog: deps.mcpCatalog });
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
