import { decrypt, encrypt } from "paseto-ts/v4";
import { getLog } from "../logging/logger.js";
import type { TokenError, TokenPayload, TokenResult } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "token-service"]);

export interface TokenServiceOptions {
  secret: Uint8Array; // 32 bytes
  ttlSeconds: number;
}

export interface TokenService {
  issue(subject: { userId: string; isAdmin: boolean }): Promise<string>;
  validate(token: string): Promise<TokenResult<TokenPayload>>;
  refresh(token: string): Promise<TokenResult<string>>;
}

const PURPOSE = "sentient.user-session.v1";
const SECRET_BYTE_LENGTH = 32;

interface PasetoClaims {
  sub: string;
  isAdmin: boolean;
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
        isAdmin: subject.isAdmin,
        purpose: PURPOSE,
        iat: new Date(iat * 1000).toISOString(),
        exp: new Date(exp * 1000).toISOString(),
      };
      const token = encrypt(localKey, claims, { addIat: false, addExp: false });
      log.debug("issue", { userId: subject.userId, isAdmin: subject.isAdmin, exp });
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
      const iat = Math.floor(new Date(claims.iat).getTime() / 1000);
      const exp = Math.floor(new Date(claims.exp).getTime() / 1000);
      return {
        ok: true,
        value: {
          userId: claims.sub,
          isAdmin: claims.isAdmin,
          issuedAt: iat,
          expiresAt: exp,
        },
      };
    },

    async refresh(token) {
      const r = await svc.validate(token);
      if (!r.ok) return r;
      const fresh = await svc.issue({ userId: r.value.userId, isAdmin: r.value.isAdmin });
      return { ok: true, value: fresh };
    },
  };

  return svc;
}
