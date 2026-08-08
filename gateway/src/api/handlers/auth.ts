import { AUDIO_PREFS_DEFAULT } from "@sentient/audio-prefs";
import { ADMIN_ROLE } from "@sentient/protocol";
import { z } from "zod";
import type { InstallState } from "../../admin/install-state.js";
import type { SecretsStore } from "../../admin/secrets-store.js";
import type { UserProvisioner } from "../../admin/user-provisioner.js";
import { getLog } from "../../logging/logger.js";
import { applyProfileDefaults } from "../../profile-store/profile-defaults.js";
import { PROFILE_SCHEMA_VERSION, type ProfileV1, profileV1Schema } from "../../profile-store/profile-types.js";
import type { AuthService } from "../../user-auth/auth-service.js";
import type { UserRecord } from "../../user-auth/types.js";

const log = getLog(["sentient", "gateway", "api", "auth"]);

const HTTP_OK = 200;
const HTTP_BAD = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL = 500;

export interface AuthHandlerDeps {
  auth: AuthService;
  /** First-admin setup goes through the provisioner so the new account
   *  gets the same slot/profile/supervisord materialization a regular
   *  admin-created user does. Optional only because the constructor
   *  argument is shared with deploys that don't run hermes (cfg.hermes
   *  unset); in that case calling /auth/setup will fail-loud. */
  userProvisioner?: UserProvisioner;
  /** Read-only snapshot of provider config; used to seed a default profile
   *  when first-admin setup is submitted from the simple SetupScreen
   *  (which collects only display name + PIN). */
  secretsStore?: SecretsStore;
  /** When present, /auth/setup advances the wizard cursor from "admin" to
   *  "finish" after the first admin is created. Non-fatal if absent or if
   *  the advance fails — the user is already created and the wizard can
   *  recover via /wizard/finalize (cursor-mismatch UI). */
  installState?: InstallState;
}

const PIN_REGEX = /^\d{4}$/;

// userId is intentionally not in the schema. The provisioner generates the
// authoritative `u_<8-hex>` id server-side; any value the client sends in the
// legacy field is ignored. Webui still includes one in the body — extra
// fields pass zod's default `strip` mode untouched.
// profile: userId and schemaVersion are server-stamped — both are omitted from
// the request body and spliced in by the handler before calling the provisioner.
const profileBodySchema = profileV1Schema.omit({ userId: true, schemaVersion: true });

const setupSchema = z.object({
  displayName: z.string().min(1).max(64),
  pin: z.string().regex(PIN_REGEX),
  // Profile is optional: the simple SetupScreen submits only displayName +
  // pin and lets the gateway seed a default profile from the wizard's
  // provider/voice config in secrets-store. The full AccountWizard
  // (member creation) supplies profile explicitly.
  profile: profileBodySchema.optional(),
});

const updateMeSchema = z.object({
  displayName: z.string().min(1).max(64),
});

const changePinSchema = z.object({
  currentPin: z.string().regex(PIN_REGEX),
  newPin: z.string().regex(PIN_REGEX),
});

const loginSchema = z.object({
  userId: z.string().min(1).max(64),
  pin: z.string().min(1).max(16),
});

export function createAuthHandler(deps: AuthHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/v1/auth/setup") return handleSetup(deps, request);
    if (path === "/api/v1/auth/users") return handleListUsers(deps, request);
    if (path === "/api/v1/auth/login") return handleLogin(deps, request);
    if (path === "/api/v1/auth/me" && request.method === "PUT") return handleUpdateMe(deps, request);
    if (path === "/api/v1/auth/me") return handleMe(deps, request);
    if (path === "/api/v1/auth/me/pin") return handleChangePin(deps, request);
    if (path === "/api/v1/auth/logout") return handleLogout(deps, request);
    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}

type ParsedSetup = z.infer<typeof setupSchema>;

async function parseSetupBody(request: Request): Promise<ParsedSetup | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(HTTP_BAD, "invalid-json");
  }
  const parsed = setupSchema.safeParse(body);
  if (!parsed.success) {
    log.debug("setup.bad-input", { reason: parsed.error.message });
    return jsonError(HTTP_BAD, "validation-error");
  }
  return parsed.data;
}

async function createFirstAdmin(
  auth: AuthService,
  provisioner: UserProvisioner,
  data: ParsedSetup,
  secretsStore?: SecretsStore,
  installState?: InstallState,
): Promise<Response> {
  // Goes through the provisioner so the new admin gets the same materialization
  // a regularly-created user does: slot binding, profile.json, supervisord
  // program with self-bootstrapping `hermes profile create` prefix. Without
  // this, first-admin would land in users.json only and the supervisord-spawned
  // worker would BACKOFF until the next manual apply.

  // Splice in server-stamped fields. userId is generated by the provisioner;
  // schemaVersion is always the current constant.
  const partial = data.profile ?? buildDefaultProfileBody(secretsStore);
  const rawProfile = { ...partial, schemaVersion: PROFILE_SCHEMA_VERSION as 1, userId: "" };
  const profile = applyProfileDefaults(rawProfile);

  const r = await provisioner.createUser({
    displayName: data.displayName,
    pin: data.pin,
    // First run: this account IS the household's operator, so it gets the one
    // role that reaches the admin REST surface and the `admin` impact tier.
    role: ADMIN_ROLE,
    profile,
  });
  if (!r.ok) {
    log.warn("setup.provisioner-failed", { kind: r.error });
    return jsonError(HTTP_INTERNAL, r.error);
  }
  const userId = r.value.userId;
  const authResult = await auth.authenticate(userId, data.pin);
  if (!authResult.ok) {
    log.warn("setup.auth-after-create-failed", { reason: authResult.error });
    return jsonError(HTTP_INTERNAL, "auth-after-create-failed");
  }
  log.info("setup.first-admin-created", { userId });

  if (installState) {
    const stateBefore = await installState.load();
    if (stateBefore.wizard_cursor === "admin") {
      const advance = await installState.advanceCursor("admin", "finish");
      if (!advance.ok) {
        log.warn("setup.cursor-advance-failed", { error: advance.error.kind });
        // Non-fatal: user is created. Wizard can recover via /wizard/finalize
        // which will surface a cursor-mismatch UI error.
      } else {
        log.info("setup.cursor-advanced", { from: "admin", to: "finish" });
      }
    }
  }

  return buildAuthResponse(authResult.value.token, authResult.value.user);
}

async function handleSetup(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const bodyOrError = await parseSetupBody(request);
  if (bodyOrError instanceof Response) return bodyOrError;
  if (!(await deps.auth.isFirstRun())) {
    return jsonError(HTTP_CONFLICT, "setup-already-completed");
  }
  if (!deps.userProvisioner) {
    log.warn("setup.no-provisioner");
    return jsonError(HTTP_INTERNAL, "no-provisioner");
  }
  return createFirstAdmin(deps.auth, deps.userProvisioner, bodyOrError, deps.secretsStore, deps.installState);
}

/** Build a profile body when SetupScreen submits without one. Reads the
 *  active LLM provider from secrets-store and seeds sane defaults for the
 *  rest. applyProfileDefaults runs afterwards to fill tools / toolsets. */
function buildDefaultProfileBody(secretsStore?: SecretsStore): Omit<ProfileV1, "userId" | "schemaVersion"> {
  const keys = secretsStore?.loadSync();
  const activeProvider = keys?.llm.active ?? "ollama-cloud";
  const defaultModelByProvider: Record<string, string> = {
    // Ollama Cloud requires the user to have signed in (`ollama signin`)
    // and to have the named model registered. Default to deepseek-v4-flash:cloud
    // because every Ollama Cloud account ships with cloud access enabled
    // for that model out of the box; the wizard can override later via
    // Settings if the operator wants a different one.
    "ollama-cloud": "deepseek-v4-flash:cloud",
    openrouter: "google/gemini-2.5-flash",
    custom: "google/gemini-2.5-flash",
  };
  return {
    model: { provider: activeProvider, id: defaultModelByProvider[activeProvider] ?? "google/gemini-2.5-flash" },
    // local-tts's single shipped voice today — see shared/config's
    // ttsConfigSchema#voice_id default. Settings → Voice can override once
    // local-tts grows a multi-voice catalog.
    voice: { provider: "local-tts", id: "default" },
    audio: AUDIO_PREFS_DEFAULT,
    persona: { template: "default", overrides: "" },
    // `permissions` is OMITTED, not `{}`: an empty table is a table naming no
    // server, which the ToolBroker reads as every server off. Absent means
    // "never set", which is what `applyProfileDefaults` seeds the starter set
    // into a line later.
    tools: { toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

async function handleListUsers(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const r = await deps.auth.listUsersPublic();
  if (!r.ok) {
    log.warn("listUsers.io-error", { reason: r.error });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
  return Response.json(r.value, { status: HTTP_OK });
}

type ParsedLogin = z.infer<typeof loginSchema>;

async function parseLoginBody(request: Request): Promise<ParsedLogin | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(HTTP_BAD, "invalid-json");
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_BAD, "validation-error");
  return parsed.data;
}

async function handleLogin(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const bodyOrError = await parseLoginBody(request);
  if (bodyOrError instanceof Response) return bodyOrError;

  const r = await deps.auth.authenticate(bodyOrError.userId, bodyOrError.pin);
  if (!r.ok) {
    log.debug("login.rejected", { userId: bodyOrError.userId, reason: r.error });
    return jsonError(HTTP_UNAUTHORIZED, "invalid-credentials");
  }
  return buildAuthResponse(r.value.token, r.value.user);
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  tag: string,
  context: Record<string, unknown>,
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(HTTP_UNPROCESSABLE, "invalid-json");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    log.debug(`${tag}.validation-error`, { ...context, reason: parsed.error.message });
    return jsonError(HTTP_UNPROCESSABLE, "validation-error");
  }
  return parsed.data;
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

/** The `{ token, user }` body every auth route answers with.
 *
 *  `isAdmin` is DERIVED from `role`, never stored. It stays on the wire beside
 *  `role` so webui / Android / iOS keep compiling and behaving correctly
 *  through the rest of plan 2026-08-07-tool-permissions; they migrate to
 *  reading `role` in tasks 6–9 and the derived field retires after that. */
function buildAuthResponse(token: string, user: UserRecord): Response {
  const { userId, displayName, role, avatarTint } = user;
  return Response.json(
    { token, user: { userId, displayName, role, isAdmin: role === ADMIN_ROLE, avatarTint } },
    { status: HTTP_OK },
  );
}

async function handleMe(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");
  const valid = await deps.auth.tokens.validate(token);
  if (!valid.ok) {
    log.debug("me.rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }
  const userR = await deps.auth.users.get(valid.value.userId);
  if (!userR.ok || !userR.value) {
    log.warn("me.user-vanished", { userId: valid.value.userId });
    return jsonError(HTTP_UNAUTHORIZED, "user-not-found");
  }
  // Renewal mints a fresh IDENTITY token — there is no authority in it to
  // converge. The `role` in the body below is read off the record on this
  // request and is display data for the client (draw the admin section or
  // not); the server re-resolves it from the record on every call regardless,
  // so a client rendering a stale copy cannot turn that into access.
  const fresh = await deps.auth.tokens.issue({ userId: userR.value.userId });
  return buildAuthResponse(fresh, userR.value);
}

async function handleLogout(_deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  // MVP: server-side logout is a noop. Token revocation deferred per spec scope.
  return Response.json({ ok: true }, { status: HTTP_OK });
}

async function handleUpdateMe(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");
  const valid = await deps.auth.tokens.validate(token);
  if (!valid.ok) {
    log.debug("updateMe.rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }
  const bodyOrError = await parseJsonBody(request, updateMeSchema, "updateMe", { userId: valid.value.userId });
  if (bodyOrError instanceof Response) return bodyOrError;
  const r = await deps.auth.updateDisplayName(valid.value.userId, bodyOrError.displayName);
  if (!r.ok) {
    if (r.error === "not-found") {
      log.warn("updateMe.user-vanished", { userId: valid.value.userId });
      return jsonError(HTTP_NOT_FOUND, "not-found");
    }
    log.warn("updateMe.failed", { userId: valid.value.userId, reason: r.error });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
  log.info("updateMe.ok", { userId: valid.value.userId });
  return buildAuthResponse(token, r.value);
}

async function handleChangePin(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "PUT") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");
  const valid = await deps.auth.tokens.validate(token);
  if (!valid.ok) {
    log.debug("changePin.rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }
  const bodyOrError = await parseJsonBody(request, changePinSchema, "changePin", { userId: valid.value.userId });
  if (bodyOrError instanceof Response) return bodyOrError;
  const r = await deps.auth.changePin(valid.value.userId, bodyOrError.currentPin, bodyOrError.newPin);
  if (!r.ok) {
    if (r.error === "wrong-pin") {
      log.debug("changePin.wrong-pin", { userId: valid.value.userId });
      return jsonError(HTTP_UNAUTHORIZED, "invalid-credentials");
    }
    if (r.error === "not-found") {
      log.warn("changePin.user-vanished", { userId: valid.value.userId });
      return jsonError(HTTP_NOT_FOUND, "not-found");
    }
    log.warn("changePin.failed", { userId: valid.value.userId, reason: r.error });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
  log.info("changePin.ok", { userId: valid.value.userId });
  return Response.json({ ok: true }, { status: HTTP_OK });
}
