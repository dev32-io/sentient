// Session tokens: the MINIMUM a client needs to identify itself to the gateway.
//
// THE TOKEN IDENTIFIES, IT NEVER AUTHORIZES (owner ruling, 2026-08-07):
//
//   "a minimum token is simply enough for client to id and communicate with the
//    server, then server ALWAYS pulls user role/user scope freshly at runtime …
//    the token is used for server to identify user AND identify what the user
//    and role scope is internally, not by trusting a token"
//
// So the claim set is `sub` + `purpose` + `iat` + `exp` and nothing else. No
// role, no `isAdmin`, no scope. Whoever decides an authorization question reads
// the user record at the moment of the decision, which is what makes a demoted
// account lose its authority on its very next request — no refresh, no
// re-login, no cache to flush, and no window in which a token out-ranks the
// record it came from.
//
// A brief earlier revision of this file DID mint a `role` claim and refuse a
// token that lacked one. Both halves are retired: the claim is gone, and a
// token carrying authority claims from any older revision (`isAdmin`, or that
// short-lived `role`) is now perfectly VALID — its extra claims are simply
// never read. Nobody is logged out for holding one, and nobody gains anything
// by holding one either, which is the point.
//
// NO `refresh`, and this ruling is why. A roll re-mints from the presented
// token's own claims — precisely the "trusting a token" the owner forbids.
// Renewal (`api/handlers/auth.ts#handleMe`) re-issues from the user record.
//
// VALIDITY IS ALSO THE RECORD'S ANSWER, not the token's. After the crypto check
// passes, `validate` reads the account's CREDENTIAL FLOOR (credential-floor.ts)
// and refuses anything issued at or before it. That is what makes a role change
// — or a deletion — revoke the credential itself rather than merely narrow what
// it opens: one choke point, every call site, nothing to track or sweep.

import { decrypt, encrypt } from "paseto-ts/v4";
import { getLog } from "../logging/logger.js";
import { type CredentialFloor, isRevoked } from "./credential-floor.js";
import type { TokenError, TokenPayload, TokenResult } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "token-service"]);

export interface TokenServiceOptions {
  secret: Uint8Array; // 32 bytes
  ttlSeconds: number;
  /**
   * Where "are this account's credentials still good?" is answered, read on
   * every `validate` (credential-floor.ts). Injected rather than looked up so
   * this stays a crypto unit with no user-store dependency — and so a caller
   * cannot assemble a token service that silently skips the check.
   */
  credentialFloor: CredentialFloor;
}

export interface TokenService {
  issue(subject: { userId: string }): Promise<string>;
  validate(token: string): Promise<TokenResult<TokenPayload>>;
}

const PURPOSE = "sentient.user-session.v1";
const SECRET_BYTE_LENGTH = 32;
const MS_PER_SECOND = 1000;

/**
 * What a REVOKED credential is refused with — the existing `expired`, never a
 * new code.
 *
 * All three clients already route `expired` to the login screen: web's message
 * router classifies any `auth.error` frame as a terminal auth failure, and
 * mobile's `AuthErrorClass.TERMINAL_AUTH_CODES` lists it by name. A new code
 * would be terminal on the `auth.error` path but fall off mobile's sessions
 * allow-list and retry forever. The semantics fit anyway: the token's lifetime
 * ended, just not by the clock.
 */
const REVOKED_ERROR: TokenError = "expired";

/** The whole claim set. Adding an authority-bearing field here re-creates the
 *  stale-grant class the ruling above closes — don't. */
interface PasetoClaims {
  sub: string;
  purpose: string;
  iat: string; // ISO
  exp: string; // ISO
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function classifyError(e: unknown): TokenError {
  const msg = (e as Error).message?.toLowerCase() ?? "";
  if (msg.includes("has expired")) return "expired";
  if (msg.includes("format") || msg.includes("invalid token") || msg.includes("not a valid")) {
    return "malformed";
  }
  return "signature-invalid";
}

function buildLocalKey(secret: Uint8Array): string {
  return `k4.local.${Buffer.from(secret).toString("base64url")}`;
}

export function createTokenService(opts: TokenServiceOptions): TokenService {
  if (opts.secret.length !== SECRET_BYTE_LENGTH) {
    throw new Error(`token-service: secret MUST be 32 bytes, got ${opts.secret.length}`);
  }
  const localKey = buildLocalKey(opts.secret);

  const svc: TokenService = {
    async issue(subject) {
      const iat = nowSeconds();
      const exp = iat + opts.ttlSeconds;
      const claims: PasetoClaims = {
        sub: subject.userId,
        purpose: PURPOSE,
        iat: new Date(iat * 1000).toISOString(),
        exp: new Date(exp * 1000).toISOString(),
      };
      const token = encrypt(localKey, claims, { addIat: false, addExp: false });
      log.debug("issue", { userId: subject.userId, exp });
      return token;
    },

    async validate(token) {
      let claims: PasetoClaims;
      try {
        const decoded = decrypt<PasetoClaims>(localKey, token);
        claims = decoded.payload as PasetoClaims;
      } catch (e: unknown) {
        const error = classifyError(e);
        log.debug("validate.reject", { error, reason: (e as Error).message });
        return { ok: false, error };
      }
      if (claims.purpose !== PURPOSE) {
        log.warn("validate.wrong-purpose", { got: claims.purpose });
        return { ok: false, error: "wrong-purpose" };
      }
      // Only `sub`, `iat` and `exp` are read. A token minted by an older
      // revision may also carry `isAdmin` or `role`; those are IGNORED, not
      // refused — the holder stays logged in and gains nothing, because
      // nothing downstream reads a claim to decide anything.
      const iat = Math.floor(new Date(claims.iat).getTime() / MS_PER_SECOND);
      const exp = Math.floor(new Date(claims.exp).getTime() / MS_PER_SECOND);

      // THE CREDENTIAL FLOOR, read from the record HERE — one choke point
      // covering all 17 `validate()` call sites, so there is no route by which
      // a caller can forget it.
      const floorMs = await opts.credentialFloor.validFromMsFor(claims.sub);
      if (floorMs === null) {
        // NO FLOOR, so no credential: the user has no record, or the store
        // could not be read. Refused identically either way — a token naming
        // nobody identifies nobody, and an unreadable store must never resolve
        // to a permissive default. WHICH of the two it was is logged by
        // `credential-floor.ts` (`floor.no-record` vs `floor.unreadable`); this
        // line must not assert a deletion it cannot distinguish, because during
        // a users.json incident it is the seam an operator greps first.
        log.warn("validate.refused", {
          userId: claims.sub,
          reason: "no-floor",
          detail: "no record, or the store could not be read — see credential-floor for which",
        });
        return { ok: false, error: REVOKED_ERROR };
      }
      if (isRevoked(iat * MS_PER_SECOND, floorMs)) {
        log.warn("validate.refused", { userId: claims.sub, issuedAt: iat, floorMs, reason: "revoked" });
        return { ok: false, error: REVOKED_ERROR };
      }

      return {
        ok: true,
        value: {
          userId: claims.sub,
          issuedAt: iat,
          expiresAt: exp,
        },
      };
    },
  };

  return svc;
}
