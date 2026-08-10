import type { McpCatalog } from "@sentient/config";
import { DEFAULT_ROLE, type UserRole, userRoleSchema } from "@sentient/protocol";
import { z } from "zod";
import { type UserProvisioner, type UserSummary, buildUserSummary } from "../../admin/user-provisioner.ts";
import { getLog } from "../../logging/logger.ts";
import { applyProfileDefaults } from "../../profile-store/profile-defaults.js";
import { PROFILE_SCHEMA_VERSION, profileV1Schema } from "../../profile-store/profile-types.ts";
import type { UserStore } from "../../user-auth/user-store.ts";
import { type AdminAuthDeps, requireAdminAuth } from "../middleware/require-admin-auth.ts";

const log = getLog(["sentient", "gateway", "api", "admin"]);

// --- HTTP status constants ---------------------------------------------------

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;

// --- Zod schemas ------------------------------------------------------------

// Profile fields the caller supplies. userId is server-generated; schemaVersion
// is server-stamped — both are omitted from the request body.
const profileBodySchema = profileV1Schema.omit({ userId: true, schemaVersion: true });

// `role` is the real field; `isAdmin` is the legacy spelling the three clients
// still send (plan 2026-08-07-tool-permissions tasks 6–9 migrate them). Both
// are optional and `role` wins, so a client can move over one at a time without
// a flag day. Neither present means the owner's default, `adult` — a create
// call that says nothing about authority must not confer any.
const createSchema = z.object({
  displayName: z.string().min(1).max(64),
  pin: z.string().regex(/^\d{4}$/),
  role: userRoleSchema.optional(),
  isAdmin: z.boolean().optional(),
  profile: profileBodySchema,
});
const resetPinSchema = z.object({ pin: z.string().regex(/^\d{4}$/) });
// A PATCH that names NEITHER field is rejected rather than silently re-roling
// somebody to the default.
const patchSchema = z
  .object({ role: userRoleSchema.optional(), isAdmin: z.boolean().optional() })
  .refine((body) => body.role !== undefined || body.isAdmin !== undefined, {
    message: "one of `role` or `isAdmin` is required",
  });

/** Resolve the legacy boolean onto the role vocabulary. `true → admin`,
 *  `false → adult` — the same mapping the stored-record migration uses, so a
 *  client that never migrates keeps producing exactly what it used to. */
function resolveRole(body: { role?: UserRole | undefined; isAdmin?: boolean | undefined }): UserRole | undefined {
  if (body.role !== undefined) return body.role;
  if (body.isAdmin === undefined) return undefined;
  return body.isAdmin ? "admin" : "adult";
}

// --- Route patterns ----------------------------------------------------------

const USER_ID_RE = /^\/api\/v1\/admin\/users\/([^/]+)$/;
const RESET_PIN_RE = /^\/api\/v1\/admin\/users\/([^/]+)\/reset-pin$/;

// --- Deps -------------------------------------------------------------------

export interface AdminDeps extends AdminAuthDeps {
  provisioner: UserProvisioner;
  userStore: UserStore;
  /** `config.yaml#mcp_catalog`. REQUIRED: a new member's permission table is
   *  seeded from it, and an empty catalog seeds an empty table — an account
   *  created with no tools at all, silently. */
  mcpCatalog: McpCatalog;
}

// --- Handler ----------------------------------------------------------------

export function createAdminHandler(deps: AdminDeps): (req: Request) => Promise<Response> {
  const guard = requireAdminAuth(deps);
  return async (req) => {
    const unauthorized = await guard(req);
    if (unauthorized) return unauthorized;

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/v1/admin/ping") return Response.json({ status: "pong" });

    if (path === "/api/v1/admin/users" && method === "GET") return handleListUsers(deps);
    if (path === "/api/v1/admin/users" && method === "POST") return handleCreateUser(deps, req);

    const resetMatch = path.match(RESET_PIN_RE);
    if (resetMatch?.[1] && method === "POST") return handleResetPin(deps, req, resetMatch[1]);

    const userIdMatch = path.match(USER_ID_RE);
    if (userIdMatch?.[1] && method === "DELETE") return handleDeleteUser(deps, userIdMatch[1]);
    if (userIdMatch?.[1] && method === "PATCH") return handlePatchUser(deps, req, userIdMatch[1]);

    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}

// --- GET /users (list with slot join) ---------------------------------------

async function handleListUsers(deps: AdminDeps): Promise<Response> {
  const usersResult = await deps.userStore.list();
  if (!usersResult.ok) return mapStoreError(usersResult.error);

  const summaries: UserSummary[] = usersResult.value.map(buildUserSummary);
  return Response.json({ users: summaries }, { status: HTTP_OK });
}

// --- POST /users (create) ---------------------------------------------------

async function handleCreateUser(deps: AdminDeps, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.flatten());

  // Splice in server-stamped fields before passing to the provisioner.
  // userId is generated by the provisioner; schemaVersion is always the
  // current constant — neither should come from the caller.
  const rawProfile = { ...parsed.data.profile, schemaVersion: PROFILE_SCHEMA_VERSION as 1, userId: "" };

  // RESOLVED ONCE, then handed to BOTH the record and the table. The default
  // is applied here rather than left to the provisioner because the seeded
  // permission table has to be the table for the role this account is about to
  // be stored with; two independent `?? "adult"` decisions are two chances to
  // seed a child's table onto an adult.
  const role = resolveRole(parsed.data) ?? DEFAULT_ROLE;
  const profile = applyProfileDefaults(rawProfile, { role, mcpCatalog: deps.mcpCatalog });

  const result = await deps.provisioner.createUser({
    displayName: parsed.data.displayName,
    pin: parsed.data.pin,
    role,
    profile,
  });
  if (!result.ok) return mapCreateError(result.error);

  log.info("createUser.success", { userId: result.value.userId, role: result.value.role });
  return Response.json({ user: result.value }, { status: HTTP_CREATED });
}

// --- DELETE /users/:id -------------------------------------------------------

async function handleDeleteUser(deps: AdminDeps, userId: string): Promise<Response> {
  const result = await deps.provisioner.deleteUser(userId);
  if (!result.ok) return mapDeleteError(result.error);

  log.info("deleteUser.success", { userId });
  return new Response(null, { status: HTTP_NO_CONTENT });
}

// --- POST /users/:id/reset-pin ----------------------------------------------

async function handleResetPin(deps: AdminDeps, req: Request, userId: string): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");

  const parsed = resetPinSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const result = await deps.provisioner.resetPin(userId, parsed.data.pin);
  if (!result.ok) return mapResetError(result.error);

  log.info("resetPin.success", { userId });
  return new Response(null, { status: HTTP_NO_CONTENT });
}

// --- PATCH /users/:id --------------------------------------------------------

async function handlePatchUser(deps: AdminDeps, req: Request, userId: string): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const role = resolveRole(parsed.data);
  if (role === undefined) return jsonError(HTTP_UNPROCESSABLE, "schema", "one of `role` or `isAdmin` is required");

  const result = await deps.provisioner.setRole(userId, role);
  if (!result.ok) return mapSetRoleError(result.error);

  const userResult = await deps.userStore.get(userId);
  if (!userResult.ok || userResult.value === null) {
    return mapStoreError("io-error");
  }

  log.info("patchUser.success", { userId, role });
  return Response.json({ user: buildUserSummary(userResult.value) }, { status: HTTP_OK });
}

// --- Error mappers -----------------------------------------------------------

type CreateError = "hash-error" | "io-error" | "apply-error" | "invalid-profile";
type DeleteError = "not-found" | "last-admin" | "io-error";
type ResetError = "hash-error" | "not-found" | "io-error";
type SetRoleError = "last-admin" | "not-found" | "io-error";

function mapCreateError(error: CreateError): Response {
  const map: Record<CreateError, { status: number; code: string }> = {
    "hash-error": { status: HTTP_INTERNAL_ERROR, code: "hash-error" },
    "io-error": { status: HTTP_INTERNAL_ERROR, code: "io-error" },
    "apply-error": { status: HTTP_BAD_GATEWAY, code: "apply-error" },
    "invalid-profile": { status: HTTP_UNPROCESSABLE, code: "invalid-profile" },
  };
  const entry = map[error];
  return jsonError(entry.status, entry.code, String(error));
}

function mapDeleteError(error: DeleteError): Response {
  if (error === "not-found") return jsonError(HTTP_NOT_FOUND, "not-found", error);
  if (error === "last-admin") return jsonError(HTTP_UNPROCESSABLE, "last-admin", error);
  return jsonError(HTTP_INTERNAL_ERROR, "io-error", error);
}

function mapResetError(error: ResetError): Response {
  if (error === "not-found") return jsonError(HTTP_NOT_FOUND, "not-found", error);
  if (error === "hash-error") return jsonError(HTTP_INTERNAL_ERROR, "hash-error", error);
  return jsonError(HTTP_INTERNAL_ERROR, "io-error", error);
}

function mapSetRoleError(error: SetRoleError): Response {
  if (error === "not-found") return jsonError(HTTP_NOT_FOUND, "not-found", error);
  if (error === "last-admin") return jsonError(HTTP_UNPROCESSABLE, "last-admin", error);
  return jsonError(HTTP_INTERNAL_ERROR, "io-error", error);
}

function mapStoreError(error: string): Response {
  return jsonError(HTTP_INTERNAL_ERROR, "io-error", error);
}

// --- Helpers -----------------------------------------------------------------

function jsonError(status: number, code: string, detail: unknown): Response {
  return Response.json({ error: code, detail }, { status });
}

async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
