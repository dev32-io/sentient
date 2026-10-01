import type { DevicesConfig } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import { z } from "zod";
import type { AccessManager } from "../../access/access-manager.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import { getLog } from "../../logging/logger.js";
import {
  type DeviceError,
  type DeviceRegistry,
  deviceBeginSchema,
  deviceRedeemSchema,
  deviceRenewSchema,
} from "../../user-auth/device-registry.js";
import type { TokenService } from "../../user-auth/token-service.js";
import type { UserStore } from "../../user-auth/user-store.js";

const log = getLog(["sentient", "gateway", "api", "devices"]);
const ROOT = "/api/v1/devices";
const ownerActionSchema = z.object({ version: z.literal(1), deviceId: z.string().uuid() }).strict();
const actions = new Set(["enroll", "redeem", "activate", "renew", "recover", "disable"]);

export interface DevicesHandlerDeps {
  registry: DeviceRegistry;
  tokens: TokenService;
  users: Pick<UserStore, "get">;
  accessManager: AccessManager;
  config: DevicesConfig;
  /** Transport fact from server composition, never forwarded headers or URL. */
  tlsEnabled: boolean;
}

export function createDevicesHandler(deps: DevicesHandlerDeps): (request: Request) => Promise<Response> {
  // Single host/global budget also bounds unauthenticated work and avoids an
  // attacker-controlled IP/id map. Proxy headers are never rate-limit identity.
  let windowEnd = 0;
  let requests = 0;
  let active = 0;
  return async (request) => {
    let admitted = false;
    try {
      if (!deps.tlsEnabled) return error(403, "tls-required");
      const now = Date.now();
      if (now >= windowEnd) {
        windowEnd = now + 60_000;
        requests = 0;
      }
      if (requests >= deps.config.requests_per_minute || active >= deps.config.max_concurrent_requests) {
        const response = error(429, "rate-limited");
        response.headers.set("Retry-After", String(Math.max(1, Math.ceil((windowEnd - now) / 1000))));
        return response;
      }
      requests++;
      active++;
      admitted = true;
      return await dispatch(deps, request);
    } catch (cause) {
      if (cause instanceof Response) return cause;
      // Storage/adapter failures can include request-derived values. Never log
      // exception messages, bodies, proofs, tokens, or recovery plaintext.
      log.warn("request.unavailable");
      return error(503, "unavailable");
    } finally {
      if (admitted) active--;
      if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
    }
  };
}

async function dispatch(deps: DevicesHandlerDeps, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const action = path === ROOT ? "list" : path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : "";
  if (action !== "list" && !actions.has(action)) return error(404, "not-found");
  if (request.method !== (action === "list" ? "GET" : "POST")) return error(405, "method-not-allowed");

  if (action === "redeem" || action === "activate" || action === "renew") {
    const body = await readBody(request, deps.config);
    if (action === "redeem") {
      const parsed = deviceRedeemSchema.safeParse(body);
      return parsed.success ? outcome(await deps.registry.redeem(parsed.data)) : error(400, "invalid-request");
    }
    const parsed = deviceRenewSchema.safeParse(body);
    return parsed.success ? outcome(await deps.registry[action](parsed.data)) : error(400, "invalid-request");
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match?.[1] || header.length > 4096) return error(401, "unauthorized");
  const valid = await deps.tokens.validate(match[1]);
  if (!valid.ok) return error(401, "unauthorized");
  const user = await deps.users.get(valid.value.userId);
  if (!user.ok || !user.value) return error(401, "unauthorized");
  const cap = deps.accessManager.grant(
    createUserPrincipal(user.value.userId, user.value.role, "home"),
    "device-registry",
  );
  if (action === "list") return outcome(await deps.registry.list(cap));
  const body = await readBody(request, deps.config);
  if (action === "enroll") {
    const parsed = deviceBeginSchema.safeParse(body);
    return parsed.success ? outcome(await deps.registry.begin(cap, parsed.data)) : error(400, "invalid-request");
  }
  const parsed = ownerActionSchema.safeParse(body);
  if (!parsed.success) return error(400, "invalid-request");
  return outcome(
    await (action === "recover"
      ? deps.registry.recover(cap, parsed.data.deviceId)
      : deps.registry.disable(cap, parsed.data.deviceId)),
  );
}

async function readBody(request: Request, config: DevicesConfig): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw error(415, "json-required");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > config.max_body_bytes))
    throw error(413, "body-too-large");
  if (!request.body) throw error(400, "invalid-request");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(error(408, "request-timeout"));
    timer = setTimeout(abort, config.body_timeout_ms);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > config.max_body_bytes) throw error(413, "body-too-large");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw error(400, "invalid-request");
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    // Do not wait for an untrusted/incomplete source to acknowledge cancel.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function outcome<T>(result: Result<T, DeviceError>): Response {
  if (result.ok) return Response.json(result.value, { headers: { "Cache-Control": "no-store" } });
  const status = { "invalid-request": 400, denied: 403, conflict: 409, expired: 410, "escrow-unavailable": 503 };
  return error(status[result.error], result.error, result.error !== "escrow-unavailable");
}
function error(status: number, code: string, canRetry = true): Response {
  return Response.json(
    { error: code, retryable: canRetry && [408, 429, 503].includes(status) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
