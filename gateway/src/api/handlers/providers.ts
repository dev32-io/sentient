import { getLog } from "../../logging/logger.js";
import type { ModelEntry } from "../../providers/catalogs/types.js";
import type { TokenService } from "../../user-auth/token-service.js";

const log = getLog(["sentient", "gateway", "api", "providers"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_UNAVAILABLE = 503;

const PATH_MODELS = "/api/v1/providers/models";

export type ProvidersListResult<T> = { ok: true; value: T; stale?: boolean } | { ok: false; error: { kind: string } };

export interface ProvidersHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  listModels: () => Promise<ProvidersListResult<ModelEntry[]>>;
}

export function createProvidersHandler(deps: ProvidersHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => handleProviders(deps, request);
}

async function handleProviders(deps: ProvidersHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const auth = await authorize(deps, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  if (url.pathname === PATH_MODELS) {
    return respondModels(await deps.listModels());
  }
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

interface AuthOk {
  ok: true;
  userId: string;
}
interface AuthFail {
  ok: false;
  response: Response;
}

async function authorize(deps: ProvidersHandlerDeps, request: Request): Promise<AuthOk | AuthFail> {
  const token = readBearer(request);
  if (!token) return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, "missing-token") };

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("providers.token-rejected", { reason: valid.error });
    return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, valid.error) };
  }
  return { ok: true, userId: valid.value.userId };
}

function respondModels(result: ProvidersListResult<ModelEntry[]>): Response {
  if (!result.ok) {
    log.warn("providers.upstream-unavailable", { key: "models", kind: result.error.kind });
    return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
  }
  const stale = result.stale ?? false;
  log.info("providers.list", { key: "models", stale });
  return Response.json({ models: result.value, stale }, { status: HTTP_OK });
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
