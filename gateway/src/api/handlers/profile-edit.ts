import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ProfileRestartError, ProfileRestartOrchestrator } from "../../admin/profile-restart-orchestrator.js";
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
const HTTP_BAD_GATEWAY = 502;
const HTTP_TIMEOUT = 504;

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
  /** Phase D restart orchestrator. */
  restartOrchestrator: ProfileRestartOrchestrator;
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
  return runRestart(deps, userId);
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
  return runRestart(deps, userId);
}

// ---------------------------------------------------------------------------
// /personalities  +  /personalities/<name>  +  /active-personality
// ---------------------------------------------------------------------------

async function handlePersonalities(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  if (request.method === "GET") return listPersonalities(deps, userId);
  if (request.method === "POST") {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const r = await addPersonality(deps, userId, body.value);
    if (r.status >= 400) return r;
    return runRestart(deps, userId);
  }
  return methodNotAllowed();
}

async function handlePersonalityNamed(
  deps: ProfileEditDeps,
  request: Request,
  userId: string,
  name: string,
): Promise<Response> {
  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    // Capture activeName BEFORE the update so we know which name to re-fire
    // after restart. The update writes a new body to the YAML map but the
    // pre-update agent.system_prompt may no longer match — list() after
    // update would resolve activeName=null. We need the original name to
    // tell Hermes to switch back.
    const wasActiveName = (await isEditingActivePersonality(deps, userId, name)) ? name : null;
    const r = await updatePersonality(deps, userId, name, body.value);
    if (r.status >= 400) return r;
    return runRestart(deps, userId, wasActiveName);
  }
  if (request.method === "DELETE") {
    const r = await removePersonality(deps, userId, name);
    if (r.status >= 400) return r;
    return runRestart(deps, userId);
  }
  return methodNotAllowed();
}

async function isEditingActivePersonality(deps: ProfileEditDeps, userId: string, name: string): Promise<boolean> {
  const list = await deps.buildPersonalityStore(userId).list();
  return list.ok && list.value.activeName === name;
}

// Active-personality re-apply formerly fired `/personality <name>` over
// the legacy custom-WS pool after a profile restart so Hermes' agent
// system_prompt picked the personality slot back up before the next user
// turn. ACP has no slash-command equivalent today; the personality file
// still lands on disk, so the next fresh session reads it. Logged no-op
// pending the ACP-side rewrite (see acp-rewire-todo.md).
async function reapplyActivePersonality(_deps: ProfileEditDeps, userId: string, name: string): Promise<void> {
  log.warn("reapplyActive.skipped-acp-no-equivalent", {
    userId,
    name,
    reason: "ACP wire has no /personality slash-command equivalent — see acp-rewire-todo.md",
  });
}

async function handleActive(deps: ProfileEditDeps, request: Request, userId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const body = await readJson(request);
  if (!body.ok) return body.response;
  return dispatchActivePersonality(deps, userId, body.value);
}

// ---------------------------------------------------------------------------
// Auth + JSON + restart helpers
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

// `forceActiveName` overrides the post-restart active-personality reapply.
// Used by the active-personality PUT path where the update itself desyncs
// agent.system_prompt and list().activeName becomes null mid-flight.
// Falls back to whatever the personality store reports as active otherwise.
async function runRestart(
  deps: ProfileEditDeps,
  userId: string,
  forceActiveName: string | null = null,
): Promise<Response> {
  log.info("runRestart.begin", { userId, forceActiveName });
  const r = await deps.restartOrchestrator.restart(userId);
  if (!r.ok) {
    log.warn("runRestart.orchestrator-failed", { userId, error: r.error.kind });
    return mapRestartError(r.error);
  }
  log.info("runRestart.orchestrator-ready", { userId, elapsedMs: r.value.elapsedMs });
  // Hermes /reset (fired by the orchestrator) clears agent.system_prompt
  // back to SOUL.md only. If the user has an active personality, we need
  // to re-fire `/personality <name>` so Hermes re-builds the personality
  // slot for the next user message. Without this, the persona silently
  // disappears on every SOUL/personality CRUD restart.
  let activeName = forceActiveName;
  if (activeName === null) {
    const list = await deps.buildPersonalityStore(userId).list();
    if (list.ok && list.value.activeName !== null) {
      activeName = list.value.activeName;
      log.debug("runRestart.active-resolved-from-store", { userId, activeName });
    } else {
      log.debug("runRestart.no-active-personality", { userId, listOk: list.ok });
    }
  }
  if (activeName !== null) {
    log.info("runRestart.reapply-begin", { userId, activeName });
    await reapplyActivePersonality(deps, userId, activeName);
    log.info("runRestart.reapply-end", { userId, activeName });
  }
  log.info("runRestart.done", { userId });
  return Response.json(r.value, { status: HTTP_OK });
}

function mapRestartError(error: ProfileRestartError): Response {
  switch (error.kind) {
    case "supervisord-failed":
      return Response.json({ error: "supervisord-failed", reason: error.reason }, { status: HTTP_BAD_GATEWAY });
    case "ws-not-ready":
      return Response.json({ error: "ws-not-ready", reason: error.reason }, { status: HTTP_TIMEOUT });
    case "resolve-failed":
      return Response.json({ error: "resolve-failed", reason: error.reason }, { status: HTTP_INTERNAL });
    default:
      return assertNever(error);
  }
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

/** Default helper for production wiring: resolve hermes-consumed profile dir. */
export function defaultResolveProfileDir(userId: string): string {
  return getHermesProfileDir(userId);
}

// Re-export for the wiring layer:
export type { PersonalityStore };
