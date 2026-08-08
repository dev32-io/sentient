import type { UserRole } from "@sentient/protocol";
import { z } from "zod";
import type { InstallState } from "../../admin/install-state.js";
import type { LlmProvider, SecretsStore } from "../../admin/secrets-store.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "secrets"]);

const ADMIN_ROLE: UserRole = "admin";

// --- HTTP status constants ---------------------------------------------------

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_ERROR = 500;

// --- Known paths -------------------------------------------------------------

const PATH_ROOT = "/api/v1/admin/secrets";
const PATH_ROTATION = "/api/v1/admin/secrets/rotation-status";
const PATH_LLM_ACTIVE = "/api/v1/admin/secrets/llm/active";
const LLM_PROVIDER_RE = /^\/api\/v1\/admin\/secrets\/llm\/(ollama-cloud|openrouter|custom)$/;
const HA_TOKEN_RE = /^\/api\/v1\/admin\/secrets\/home_assistant\/(observe_token|mcp_server_token)$/;
const PATH_HA_URL = "/api/v1/admin/secrets/home_assistant/url";
const PATH_HA_LOCAL_IP = "/api/v1/admin/secrets/home_assistant/local_ip";
const PATH_MA_TOKEN = "/api/v1/admin/secrets/music_assistant";
const PATH_MA_URL = "/api/v1/admin/secrets/music_assistant/url";
const PATH_MA_LOCAL_IP = "/api/v1/admin/secrets/music_assistant/local_ip";

const LLM_PROVIDERS = ["ollama-cloud", "openrouter", "custom"] as const;

// --- Zod schemas -------------------------------------------------------------

// At least one of value or base_url must be present; both are optional so callers
// can update either field independently without touching the other.
const LlmKeyPatchSchema = z
  .object({
    value: z.string().optional(),
    base_url: z.string().optional(),
  })
  .refine((d) => d.value !== undefined || d.base_url !== undefined, {
    message: "At least one of 'value' or 'base_url' is required",
  });

const SecretValueSchema = z.object({ value: z.string() });
const ActiveProviderSchema = z.object({ provider: z.enum(LLM_PROVIDERS) });

// --- Deps -------------------------------------------------------------------

/** Resolves the caller's ROLE, or `{ok:false}` if it cannot be established at
 *  all. The role — not a boolean — because `admin` is one of them now; the
 *  gate below is the only thing that decides what "admin" buys. */
export type RequireAdminFn = (req: Request) => Promise<{ ok: true; value: { role: UserRole } } | { ok: false }>;

export interface SecretsDeps {
  installState: InstallState;
  secretsStore: SecretsStore;
  requireAdmin: RequireAdminFn;
}

// --- Handler ----------------------------------------------------------------

export function createSecretsHandler(deps: SecretsDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method !== "GET" && method !== "PUT") {
      return jsonError(HTTP_METHOD_NOT_ALLOWED, "method-not-allowed", `${method} not allowed`);
    }

    // Bootstrap gate — checked BEFORE auth to avoid leaking admin-token validity
    const state = await deps.installState.load();
    if (!state.bootstrap_complete) {
      return jsonError(HTTP_PRECONDITION_FAILED, "bootstrap-incomplete", "Setup wizard not yet complete");
    }

    // Admin gate
    const authResult = await deps.requireAdmin(req);
    if (!authResult.ok) {
      return jsonError(401, "unauthorized", "Missing or invalid token");
    }
    if (authResult.value.role !== ADMIN_ROLE) {
      return jsonError(HTTP_FORBIDDEN, "forbidden", "Admin role required");
    }

    // Route dispatch
    if (path === PATH_ROOT && method === "GET") return handleGetSecrets(deps);
    if (path === PATH_ROTATION && method === "GET") return handleGetRotation();
    if (path === PATH_LLM_ACTIVE && method === "PUT") return handlePutLlmActive(deps, req);
    if (path === PATH_HA_URL && method === "PUT") return handlePutHaUrl(deps, req);
    if (path === PATH_HA_LOCAL_IP && method === "PUT") return handlePutHaLocalIp(deps, req);
    if (path === PATH_MA_TOKEN && method === "PUT") return handlePutMaToken(deps, req);
    if (path === PATH_MA_URL && method === "PUT") return handlePutMaUrl(deps, req);
    if (path === PATH_MA_LOCAL_IP && method === "PUT") return handlePutMaLocalIp(deps, req);

    const llmMatch = path.match(LLM_PROVIDER_RE);
    if (llmMatch?.[1] && method === "PUT") return handlePutLlmProvider(deps, req, llmMatch[1] as LlmProvider);

    const haMatch = path.match(HA_TOKEN_RE);
    if (haMatch?.[1] && method === "PUT") {
      return handlePutHaToken(deps, req, haMatch[1] as "observe_token" | "mcp_server_token");
    }

    return jsonError(HTTP_NOT_FOUND, "not-found", path);
  };
}

// --- GET /secrets (boolean presence only) ------------------------------------

async function handleGetSecrets(deps: SecretsDeps): Promise<Response> {
  const keys = await deps.secretsStore.load();
  const body = {
    llm: {
      active: keys.llm.active,
      ollama_cloud: {
        has_key: keys.llm.ollama_cloud.api_key !== null,
        has_base_url: keys.llm.ollama_cloud.base_url !== null,
      },
      openrouter: {
        has_key: keys.llm.openrouter.api_key !== null,
        has_base_url: keys.llm.openrouter.base_url !== null,
      },
      custom: {
        has_key: keys.llm.custom.api_key !== null,
        has_base_url: keys.llm.custom.base_url !== null,
      },
    },
    home_assistant: {
      url: keys.home_assistant.url,
      observe_token: { has_token: keys.home_assistant.observe_token !== null },
      mcp_server_token: { has_token: keys.home_assistant.mcp_server_token !== null },
    },
    music_assistant: { url: keys.music_assistant.url, has_token: keys.music_assistant.token !== null },
  };
  log.debug("secrets.get", {
    activeLlm: keys.llm.active,
    hasHaObserve: keys.home_assistant.observe_token !== null,
    hasMa: keys.music_assistant.token !== null,
  });
  return Response.json(body, { status: HTTP_OK });
}

// --- GET /secrets/rotation-status -------------------------------------------

function handleGetRotation(): Promise<Response> {
  // Rotation is not yet implemented; return a stub
  return Promise.resolve(Response.json({ status: "idle" }, { status: HTTP_OK }));
}

// --- PUT /secrets/llm/active -------------------------------------------------

async function handlePutLlmActive(deps: SecretsDeps, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = ActiveProviderSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const { provider } = parsed.data;
  const result = await deps.secretsStore.setActiveLlmProvider(provider);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.llm.active-changed", { provider });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- PUT /secrets/llm/{provider} --------------------------------------------

async function handlePutLlmProvider(deps: SecretsDeps, req: Request, provider: LlmProvider): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = LlmKeyPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  // Build patch — only include fields that were present in the request body.
  // Empty string means "clear that field"; undefined means "leave untouched".
  const patch: { api_key?: string | null; base_url?: string | null } = {};
  if (parsed.data.value !== undefined) patch.api_key = parsed.data.value === "" ? null : parsed.data.value;
  if (parsed.data.base_url !== undefined) patch.base_url = parsed.data.base_url === "" ? null : parsed.data.base_url;

  const result = await deps.secretsStore.setLlmProviderKey(provider, patch);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.llm.key-set", {
    provider,
    hasKey: patch.api_key !== undefined ? patch.api_key !== null : undefined,
  });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- PUT /secrets/home_assistant/{kind} -------------------------------------

async function handlePutHaToken(
  deps: SecretsDeps,
  req: Request,
  kind: "observe_token" | "mcp_server_token",
): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = SecretValueSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const token = parsed.data.value === "" ? null : parsed.data.value;
  const result = await deps.secretsStore.setHomeAssistantToken(kind, token);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.ha.token-set", { kind, hasToken: token !== null });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- PUT /secrets/home_assistant/url ----------------------------------------

async function handlePutHaUrl(deps: SecretsDeps, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = SecretValueSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const url = parsed.data.value === "" ? null : parsed.data.value;
  const result = await deps.secretsStore.setHomeAssistantUrl(url);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.ha.url-set", { hasUrl: url !== null });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- PUT /secrets/music_assistant -------------------------------------------

async function handlePutMaToken(deps: SecretsDeps, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = SecretValueSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const token = parsed.data.value === "" ? null : parsed.data.value;
  const result = await deps.secretsStore.setMusicAssistantToken(token);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.ma.token-set", { hasToken: token !== null });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- PUT /secrets/music_assistant/url ----------------------------------------

async function handlePutMaUrl(deps: SecretsDeps, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = SecretValueSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const url = parsed.data.value === "" ? null : parsed.data.value;
  const result = await deps.secretsStore.setMusicAssistantUrl(url);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.ma.url-set", { hasUrl: url !== null });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- PUT /secrets/home_assistant/local_ip -----------------------------------

async function handlePutHaLocalIp(deps: SecretsDeps, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = SecretValueSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const ip = parsed.data.value === "" ? null : parsed.data.value;
  const result = await deps.secretsStore.setHomeAssistantLocalIp(ip);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.ha.local-ip-set", { hasIp: ip !== null });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- PUT /secrets/music_assistant/local_ip ----------------------------------

async function handlePutMaLocalIp(deps: SecretsDeps, req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) return jsonError(HTTP_UNPROCESSABLE, "schema", "Invalid JSON body");
  const parsed = SecretValueSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_UNPROCESSABLE, "schema", parsed.error.message);

  const ip = parsed.data.value === "" ? null : parsed.data.value;
  const result = await deps.secretsStore.setMusicAssistantLocalIp(ip);
  if (!result.ok) return jsonError(HTTP_INTERNAL_ERROR, "io-error", result.error.kind);

  log.info("secrets.ma.local-ip-set", { hasIp: ip !== null });
  return Response.json({ ok: true }, { status: HTTP_OK });
}

// --- Helpers -----------------------------------------------------------------

function jsonError(status: number, code: string, detail: string): Response {
  return Response.json({ error: code, detail }, { status });
}

async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
