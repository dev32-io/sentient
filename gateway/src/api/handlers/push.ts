import {
  PUSH_PREFERENCES_ROUTE,
  PUSH_REGISTRATIONS_ROUTE,
  PUSH_REVOCATIONS_ROUTE,
  type PushErrorCode,
  pushPreferenceGetQuerySchema,
  pushPreferencePatchRequestSchema,
  pushRegistrationRequestSchema,
  pushRevokeRequestSchema,
} from "@sentient/protocol";
import type { AccessManager } from "../../access/access-manager.js";
import { PrivatePushResource } from "../../access/private-push-resource.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import type { PushRegistrationAuthority, PushRevocationAuthority } from "../../push/contracts.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";

export interface PushHandlerDeps {
  tokens: { validate(token: string): Promise<TokenResult<TokenPayload>> };
  users: Pick<UserStore, "get">;
  accessManager: AccessManager;
  registrations: PushRegistrationAuthority;
  revocations: PushRevocationAuthority;
  now?: () => Date;
}

export function createPushHandler(deps: PushHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === PUSH_REVOCATIONS_ROUTE) {
        if (request.method !== "POST") return pushError(405, "validation", "Method not allowed", false);
        const body = await json(request);
        const parsed = pushRevokeRequestSchema.safeParse(body);
        if (!parsed.success) return pushError(422, "validation", "Invalid revocation request", false);
        const result = await deps.revocations.revoke(parsed.data, deps.now?.() ?? new Date());
        return result.ok ? Response.json(result.value) : resultError(result.error);
      }
      if (pathname !== PUSH_REGISTRATIONS_ROUTE && pathname !== PUSH_PREFERENCES_ROUTE)
        return pushError(404, "not_found", "Push route not found", false);

      const resource = await authenticate(deps, request);
      if (resource instanceof Response) return resource;
      if (pathname === PUSH_REGISTRATIONS_ROUTE) {
        if (request.method !== "POST") return pushError(405, "validation", "Method not allowed", false);
        const parsed = pushRegistrationRequestSchema.safeParse(await json(request));
        if (!parsed.success) return pushError(422, "validation", "Invalid registration request", false);
        const result = await deps.registrations.issue(resource, parsed.data, deps.now?.() ?? new Date());
        return result.ok ? Response.json(result.value) : resultError(result.error);
      }
      if (request.method === "GET") {
        const url = new URL(request.url);
        const parsed = pushPreferenceGetQuerySchema.safeParse({
          installationId: url.searchParams.get("installationId"),
        });
        if (!parsed.success) return pushError(422, "validation", "Invalid preferences query", false);
        const result = await deps.registrations.readPreferences(resource, parsed.data.installationId);
        return result.ok ? Response.json({ binding: result.value }) : resultError(result.error);
      }
      if (request.method === "PATCH") {
        const parsed = pushPreferencePatchRequestSchema.safeParse(await json(request));
        if (!parsed.success) return pushError(422, "validation", "Invalid preferences update", false);
        const value = parsed.data;
        const changes = {
          ...(value.changes.enabled !== undefined ? { enabled: value.changes.enabled } : {}),
          ...(value.changes.previewMode !== undefined ? { previewMode: value.changes.previewMode } : {}),
        };
        const result = await deps.registrations.updatePreferences(
          resource,
          value.bindingId,
          value.generation,
          value.expectedRevision,
          changes,
        );
        return result.ok ? Response.json({ binding: result.value }) : resultError(result.error);
      }
      return pushError(405, "validation", "Method not allowed", false);
    } catch {
      return pushError(503, "internal", "Push service is unavailable", true);
    }
  };
}

async function authenticate(deps: PushHandlerDeps, request: Request): Promise<PrivatePushResource | Response> {
  const token = bearer(request);
  if (!token) return pushError(401, "forbidden", "Bearer authentication is required", false);
  let valid: TokenResult<TokenPayload>;
  try {
    valid = await deps.tokens.validate(token);
  } catch {
    return pushError(503, "internal", "Authentication unavailable", true);
  }
  if (!valid.ok) return pushError(401, "forbidden", "Invalid bearer token", false);
  try {
    const user = await deps.users.get(valid.value.userId);
    if (!user.ok || !user.value) return pushError(401, "forbidden", "Authenticated user was not found", false);
    const principal = createUserPrincipal(valid.value.userId, user.value.role, "home");
    return new PrivatePushResource(deps.accessManager.grant(principal, "push-private"));
  } catch {
    return pushError(503, "internal", "User service unavailable", true);
  }
}
function bearer(request: Request): string | null {
  const parts = (request.headers.get("authorization") ?? "").trim().split(/\s+/);
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer" ? (parts[1] ?? null) : null;
}
async function json(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
function resultError(error: { code: PushErrorCode | "closed"; retryable: boolean }): Response {
  const code = error.code === "closed" ? "internal" : error.code;
  const status =
    code === "forbidden"
      ? 403
      : code === "not_found"
        ? 404
        : ["conflict", "idempotency_conflict", "binding_generation_mismatch", "old_binding_active"].includes(code)
          ? 409
          : code === "validation"
            ? 422
            : code === "invalid_revocation_authority" || code === "expired_revocation_authority"
              ? 401
              : 503;
  return pushError(status, code, message(code), error.retryable);
}
function message(code: PushErrorCode): string {
  const messages: Record<PushErrorCode, string> = {
    validation: "Invalid push request",
    forbidden: "Push operation is forbidden",
    not_found: "Push binding was not found",
    conflict: "Push binding changed",
    idempotency_conflict: "Idempotency key was already used for another request",
    invalid_revocation_authority: "Invalid revocation authority",
    expired_revocation_authority: "Revocation authority expired",
    binding_generation_mismatch: "Push binding generation does not match",
    old_binding_active: "Old push binding is still active",
    provider_unavailable: "Push provider is temporarily unavailable",
    internal: "Push service is unavailable",
  };
  return messages[code];
}
function pushError(status: number, code: PushErrorCode, messageText: string, retryable: boolean): Response {
  return Response.json({ error: { code, message: messageText, retryable } }, { status });
}
