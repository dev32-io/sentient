import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getLog } from "../../logging/logger.js";
import { MEMORY_CHAR_LIMIT, USER_CHAR_LIMIT } from "../../profile-store/memory-constants.js";
import type { PersonalityStore } from "../../profile-store/personality-store.js";
import type { TemplateLoader } from "../../profile-store/template-loader.js";
import { writeFileAtomic } from "../../user-auth/atomic-write.js";
import { getHermesProfileDir } from "../../user-auth/paths.js";
import type { TokenService } from "../../user-auth/token-service.js";
import {
  type PersonalityHandlerDeps,
  addPersonality,
  dispatchActivePersonality,
  jsonError,
  listPersonalities,
  methodNotAllowed,
  notFound,
  removePersonality,
  updatePersonality,
} from "./profile-edit-personalities.js";

const log = getLog(["sentient", "gateway", "api", "profile-edit"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL = 500;

const SOUL_FILENAME = "SOUL.md";
const SOUL_FILE_MODE = 0o600;
const MEMORY_DIR = "memories";
const MEMORY_FILE_MODE = 0o600;
const NAME_PATH_RE = /^\/api\/v1\/profile\/personalities\/([^/]+)$/;

type MemorySlot = "memory" | "user";

const MEMORY_FILES: Record<MemorySlot, string> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

const MEMORY_LIMITS: Record<MemorySlot, number> = {
  memory: MEMORY_CHAR_LIMIT,
  user: USER_CHAR_LIMIT,
};

export interface ProfileEditDeps extends PersonalityHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  /** Resolve the absolute path of the user's profile dir (for SOUL.md). */
  resolveProfileDir: (userId: string) => string;
  /** Load the seed SOUL template. Used by the "Restore to default"
   *  action — returns the operator-shipped builtin or shared/templates
   *  override so the user can roll back without remembering the canonical
   *  text. */
  templateLoader: Pick<TemplateLoader, "loadOrBuiltinDefault">;
}

export function createProfileEditHandler(deps: ProfileEditDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const auth = await authenticate(deps.tokens, request);
    if (!auth.ok) return auth.response;
    return dispatch(deps, request, auth.userId);
  };
}

async function dispatch(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/profile/soul") return handleSoul(deps, request, userId);
  if (path === "/api/v1/profile/soul/default") return handleSoulDefault(deps, request, userId);
  if (path === "/api/v1/profile/memory/memory") return handleMemory(deps, request, userId, "memory");
  if (path === "/api/v1/profile/memory/user") return handleMemory(deps, request, userId, "user");
  if (path === "/api/v1/profile/personalities") return handlePersonalities(deps, request, userId);
  if (path === "/api/v1/profile/active-personality") return handleActive(deps, request, userId);
  const named = NAME_PATH_RE.exec(path);
  if (named) return handlePersonalityNamed(deps, request, userId, decodeURIComponent(named[1] ?? ""));
  return notFound();
}

// Returns the seed SOUL template (operator default). The webui's
// "Restore to default" button calls this to populate the editor with
// the canonical text so the user can review before saving.
async function handleSoulDefault(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const r = await deps.templateLoader.loadOrBuiltinDefault();
  if (!r.ok) {
    log.warn("soul.default.load-failed", { userId, reason: r.error });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
  return Response.json({ content: r.value }, { status: HTTP_OK });
}

// ---------------------------------------------------------------------------
// /soul — GET / PUT
// ---------------------------------------------------------------------------

async function handleSoul(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  if (request.method === "GET") return getSoul(deps, userId);
  if (request.method === "PUT") return putSoul(deps, request, userId);
  return methodNotAllowed();
}

async function getSoul(deps: ProfileEditDeps, userId: string): Promise<Response> {
  const path = join(deps.resolveProfileDir(userId), SOUL_FILENAME);
  log.info("soul.get", { userId });
  try {
    const content = await fs.readFile(path, "utf8");
    const stat = await fs.stat(path);
    return Response.json({ content, lastModified: stat.mtime.toISOString() }, { status: HTTP_OK });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return Response.json({ content: "", lastModified: null }, { status: HTTP_OK });
    }
    log.warn("soul.get.io-error", { userId, reason: (e as Error).message });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
}

async function putSoul(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const content = (body.value as { content?: unknown }).content;
  if (typeof content !== "string") return jsonError(HTTP_UNPROCESSABLE, "schema-invalid");
  const path = join(deps.resolveProfileDir(userId), SOUL_FILENAME);
  log.info("soul.put", { userId, bytes: content.length });
  try {
    await writeFileAtomic(path, content, { mode: SOUL_FILE_MODE });
  } catch (e: unknown) {
    log.warn("soul.put.io-error", { userId, reason: (e as Error).message });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
  return editApplied(userId, startedAt);
}

// ---------------------------------------------------------------------------
// /memory/<slot> — GET / PUT for MEMORY.md and USER.md
// ---------------------------------------------------------------------------

async function handleMemory(
  deps: ProfileEditDeps,
  request: Request,
  userId: string,
  slot: MemorySlot,
): Promise<Response> {
  if (request.method === "GET") return getMemory(deps, userId, slot);
  if (request.method === "PUT") return putMemory(deps, request, userId, slot);
  return methodNotAllowed();
}

function memoryPath(deps: ProfileEditDeps, userId: string, slot: MemorySlot): string {
  return join(deps.resolveProfileDir(userId), MEMORY_DIR, MEMORY_FILES[slot]);
}

async function getMemory(deps: ProfileEditDeps, userId: string, slot: MemorySlot): Promise<Response> {
  const path = memoryPath(deps, userId, slot);
  log.info("memory.get", { userId, slot });
  try {
    const content = await fs.readFile(path, "utf8");
    const stat = await fs.stat(path);
    return Response.json(
      { content, lastModified: stat.mtime.toISOString(), charLimit: MEMORY_LIMITS[slot] },
      { status: HTTP_OK },
    );
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Hermes hasn't written anything yet — return empty + cap so the UI can render the editor.
      return Response.json({ content: "", lastModified: null, charLimit: MEMORY_LIMITS[slot] }, { status: HTTP_OK });
    }
    log.warn("memory.get.io-error", { userId, slot, reason: (e as Error).message });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
}

async function putMemory(deps: ProfileEditDeps, request: Request, userId: string, slot: MemorySlot): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const content = (body.value as { content?: unknown }).content;
  if (typeof content !== "string") return jsonError(HTTP_UNPROCESSABLE, "schema-invalid");
  const cap = MEMORY_LIMITS[slot];
  if (content.length > cap) {
    log.warn("memory.put.over-cap", { userId, slot, length: content.length, cap });
    return jsonError(HTTP_UNPROCESSABLE, "over-char-limit");
  }
  const path = memoryPath(deps, userId, slot);
  log.info("memory.put", { userId, slot, bytes: content.length });
  try {
    await fs.mkdir(join(deps.resolveProfileDir(userId), MEMORY_DIR), { recursive: true });
    await writeFileAtomic(path, content, { mode: MEMORY_FILE_MODE });
  } catch (e: unknown) {
    log.warn("memory.put.io-error", { userId, slot, reason: (e as Error).message });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
  return editApplied(userId, startedAt);
}

// ---------------------------------------------------------------------------
// /personalities  +  /personalities/<name>  +  /active-personality
// ---------------------------------------------------------------------------

async function handlePersonalities(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  const startedAt = Date.now();
  if (request.method === "GET") return listPersonalities(deps, userId);
  if (request.method === "POST") {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const r = await addPersonality(deps, userId, body.value);
    if (r.status >= 400) return r;
    return editApplied(userId, startedAt);
  }
  return methodNotAllowed();
}

async function handlePersonalityNamed(
  deps: ProfileEditDeps,
  request: Request,
  userId: string,
  name: string,
): Promise<Response> {
  const startedAt = Date.now();
  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const r = await updatePersonality(deps, userId, name, body.value);
    if (r.status >= 400) return r;
    return editApplied(userId, startedAt);
  }
  if (request.method === "DELETE") {
    const r = await removePersonality(deps, userId, name);
    if (r.status >= 400) return r;
    return editApplied(userId, startedAt);
  }
  return methodNotAllowed();
}

async function handleActive(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const body = await readJson(request);
  if (!body.ok) return body.response;
  return dispatchActivePersonality(deps, userId, body.value);
}

// ---------------------------------------------------------------------------
// Auth + JSON + edit-outcome helpers
// ---------------------------------------------------------------------------

interface AuthOk {
  ok: true;
  userId: string;
}
interface AuthErr {
  ok: false;
  response: Response;
}

async function authenticate(tokens: Pick<TokenService, "validate">, request: Request): Promise<AuthOk | AuthErr> {
  const token = readBearer(request);
  if (!token) return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, "missing-token") };
  const valid = await tokens.validate(token);
  if (!valid.ok) {
    log.debug("token-rejected", { reason: valid.error });
    return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, valid.error) };
  }
  return { ok: true, userId: valid.value.userId };
}

interface JsonOk {
  ok: true;
  value: unknown;
}
interface JsonErr {
  ok: false;
  response: Response;
}

async function readJson(request: Request): Promise<JsonOk | JsonErr> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: jsonError(HTTP_UNPROCESSABLE, "invalid-json") };
  }
}

// A profile edit is complete the moment it is on disk.
//
// This used to restart the per-user Hermes daemon (`ProfileRestartOrchestrator`
// → `supervisorctl restart hermes-<userId>-*`) and then re-fire
// `/personality <name>` so the running worker re-read its system prompt. There
// is no running worker in the native stack: Hermes is a one-shot exec whose
// `cwd` is the profile dir (tools/hermes-runner.ts), so the NEXT delegation
// reads whatever was just written. Both steps had already decayed to logged
// no-ops during the ACP purge; they are now gone rather than stubbed.
//
// The response body is unchanged (`{ state, elapsedMs }`) — webui and the
// mobile SDK consume that shape. `forceActiveName` is likewise gone: it only
// existed to steer the reapply.
function editApplied(userId: string, startedAt: number): Response {
  const elapsedMs = Date.now() - startedAt;
  log.info("editApplied", { userId, elapsedMs });
  return Response.json({ state: "ready", elapsedMs }, { status: HTTP_OK });
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

/** Default helper for production wiring: resolve hermes-consumed profile dir. */
export function defaultResolveProfileDir(userId: string): string {
  return getHermesProfileDir(userId);
}

// Re-export for the wiring layer:
export type { PersonalityStore };
