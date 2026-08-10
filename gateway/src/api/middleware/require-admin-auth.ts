// The gate on every `/api/v1/admin/*` route.
//
// THE TOKEN IDENTIFIES, IT NEVER AUTHORIZES (owner ruling, 2026-08-07). This
// used to read a `role` claim out of the presented token, which meant a token
// minted while its holder was an admin kept opening this door after she was
// demoted — until it expired, and the client re-rolled it before that could
// ever happen. Now the token only says WHO, and the answer to WHETHER is read
// from that user's record on this request. Demote someone and their very next
// call here is refused: no refresh, no re-login, no cache to flush.

import { ADMIN_ROLE } from "@sentient/protocol";
import { getLog } from "../../logging/logger.ts";
import type { TokenService } from "../../user-auth/token-service.ts";
import type { UserStore } from "../../user-auth/user-store.ts";

const log = getLog(["sentient", "gateway", "api", "require-admin-auth"]);

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
  /** Where the ANSWER comes from. The token names a user; this resolves what
   *  that user may do, at the moment of the decision. */
  userStore: Pick<UserStore, "get">;
}

/** Returns a guard function. The guard returns `undefined` to let the
 *  request through, or a `Response` (401/403/503) to short-circuit it.
 *
 *  Accepts two auth methods:
 *  1. Static `ADMIN_TOKEN` Bearer header (machine-to-machine)
 *  2. PASETO session token identifying a user whose CURRENT record says `admin` */
export function requireAdminAuth(deps: AdminAuthDeps): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const header = request.headers.get("Authorization") ?? "";
    if (!header.startsWith(BEARER_PREFIX)) {
      return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
    }
    const token = header.slice(BEARER_PREFIX.length);

    // 1. Static admin token (machine-to-machine). Not a user at all — it is
    //    the operator's own out-of-band credential, so there is no record to
    //    resolve and nothing to go stale.
    if (deps.adminToken && token === deps.adminToken) {
      return undefined;
    }

    // 2. Session token → userId → THE RECORD → the decision.
    if (deps.tokenService) {
      const result = await deps.tokenService.validate(token);
      if (result.ok) {
        const stored = await deps.userStore.get(result.value.userId);
        if (!stored.ok || stored.value === null) {
          // FAIL CLOSED. A token naming a user who is not there identifies
          // nobody, so it is an invalid credential — never a defaulted role.
          log.warn("admin-auth.no-record", {
            userId: result.value.userId,
            reason: stored.ok ? "token names a user with no record" : stored.error,
          });
          return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
        }
        if (stored.value.role === ADMIN_ROLE) return undefined;
        log.info("admin-auth.denied", { userId: result.value.userId, role: stored.value.role });
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
