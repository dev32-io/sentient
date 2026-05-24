import type { TokenService } from "../../user-auth/token-service.ts";

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;

const BEARER_PREFIX = "Bearer ";

export interface AdminAuthDeps {
  /** The admin bearer token, read from the ADMIN_TOKEN env at bootstrap.
   *  `undefined` means the static-token path is disabled; PASETO session
   *  tokens from admin users are still accepted when `tokenService` is provided. */
  adminToken: string | undefined;
  tokenService?: TokenService;
}

/** Returns a guard function. The guard returns `undefined` to let the
 *  request through, or a `Response` (401/403/503) to short-circuit it.
 *
 *  Accepts two auth methods:
 *  1. Static `ADMIN_TOKEN` Bearer header (machine-to-machine)
 *  2. PASETO session token from an admin user (webui) */
export function requireAdminAuth(deps: AdminAuthDeps): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const header = request.headers.get("Authorization") ?? "";
    if (!header.startsWith(BEARER_PREFIX)) {
      return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
    }
    const token = header.slice(BEARER_PREFIX.length);

    // 1. Static admin token (machine-to-machine)
    if (deps.adminToken && token === deps.adminToken) {
      return undefined;
    }

    // 2. PASETO session token from admin user (webui)
    if (deps.tokenService) {
      const result = await deps.tokenService.validate(token);
      if (result.ok) {
        if (result.value.isAdmin) return undefined;
        return new Response("Forbidden: admin required", { status: HTTP_FORBIDDEN });
      }
    }

    // No adminToken AND no tokenService → 503
    if (!deps.adminToken && !deps.tokenService) {
      return new Response("Admin surface not configured", { status: HTTP_SERVICE_UNAVAILABLE });
    }

    return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
  };
}
