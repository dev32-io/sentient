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

import { decrypt, encrypt } from "paseto-ts/v4";
import { getLog } from "../logging/logger.js";
import type { TokenError, TokenPayload, TokenResult } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "token-service"]);

export interface TokenServiceOptions {
  secret: Uint8Array; // 32 bytes
  ttlSeconds: number;
}

export interface TokenService {
  issue(subject: { userId: string }): Promise<string>;
  validate(token: string): Promise<TokenResult<TokenPayload>>;
}

const PURPOSE = "sentient.user-session.v1";
const SECRET_BYTE_LENGTH = 32;

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
      const iat = Math.floor(new Date(claims.iat).getTime() / 1000);
      const exp = Math.floor(new Date(claims.exp).getTime() / 1000);
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
