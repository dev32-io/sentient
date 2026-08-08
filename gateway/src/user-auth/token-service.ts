import { type UserRole, userRoleSchema } from "@sentient/protocol";
import { decrypt, encrypt } from "paseto-ts/v4";
import { getLog } from "../logging/logger.js";
import type { TokenError, TokenPayload, TokenResult } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "token-service"]);

export interface TokenServiceOptions {
  secret: Uint8Array; // 32 bytes
  ttlSeconds: number;
}

export interface TokenService {
  issue(subject: { userId: string; role: UserRole }): Promise<string>;
  validate(token: string): Promise<TokenResult<TokenPayload>>;
  refresh(token: string): Promise<TokenResult<string>>;
}

const PURPOSE = "sentient.user-session.v1";
const SECRET_BYTE_LENGTH = 32;

interface PasetoClaims {
  sub: string;
  /** REPLACED the `isAdmin` claim (plan 2026-08-07-tool-permissions task 2b).
   *  Typed as `unknown` because it is attacker-adjacent input the moment a
   *  token predates the claim or was hand-crafted — `validate` parses it
   *  before anything reads it as a role. */
  role: unknown;
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
        role: subject.role,
        purpose: PURPOSE,
        iat: new Date(iat * 1000).toISOString(),
        exp: new Date(exp * 1000).toISOString(),
      };
      const token = encrypt(localKey, claims, { addIat: false, addExp: false });
      log.debug("issue", { userId: subject.userId, role: subject.role, exp });
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
      // A token minted before the role claim existed is otherwise perfectly
      // valid — right key, right purpose, unexpired — so it has to be REFUSED
      // explicitly. There is no safe default: `admin` would be a privilege
      // escalation off a claim the token never made, and `adult` would still
      // hand a demoted account authority it no longer has. Its holder
      // re-authenticates and gets a token that says what it means.
      //
      // Reported as `malformed`, an EXISTING TokenError, because all three
      // clients already treat that code as terminal and route to login; a new
      // code would fall off mobile's sessions-error allow-list and retry
      // forever instead.
      const role = userRoleSchema.safeParse(claims.role);
      if (!role.success) {
        log.warn("validate.role-claim-missing", {
          userId: claims.sub,
          reason: "token carries no usable role claim; refusing rather than defaulting one",
        });
        return { ok: false, error: "malformed" };
      }
      const iat = Math.floor(new Date(claims.iat).getTime() / 1000);
      const exp = Math.floor(new Date(claims.exp).getTime() / 1000);
      return {
        ok: true,
        value: {
          userId: claims.sub,
          role: role.data,
          issuedAt: iat,
          expiresAt: exp,
        },
      };
    },

    async refresh(token) {
      const r = await svc.validate(token);
      if (!r.ok) return r;
      const fresh = await svc.issue({ userId: r.value.userId, role: r.value.role });
      return { ok: true, value: fresh };
    },
  };

  return svc;
}
