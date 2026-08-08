// SECURITY BOUNDARY — the admin gate the SECRETS surface is built on.
//
// `buildRequireAdmin` is the second of the gateway's two admin resolvers
// (`api/middleware/require-admin-auth.ts` is the first, guarding
// `/api/v1/admin/*`). Nothing constructed it before: `secrets.test.ts` stubs
// `requireAdmin` wholesale, so the resolver itself — the one that decides who
// may read and write the household's API keys — was never exercised.
//
// THE TOKEN IDENTIFIES, IT NEVER AUTHORIZES. Every case here is about where
// the answer comes from: the record, on this request, with no defaulted role
// anywhere on the failure paths.

import { describe, expect, it } from "vitest";
import { buildRequireAdmin } from "./server.ts";
import type { TokenService } from "./user-auth/token-service.ts";
import type { StoreResult, UserRecord } from "./user-auth/types.ts";

const KEVIN = "u_a1b2c3d4";
const STATIC_ADMIN_TOKEN = "operator-out-of-band-token";

function requestWith(authorization: string | null): Request {
  return new Request("https://x/api/v1/admin/secrets", {
    ...(authorization === null ? {} : { headers: { authorization } }),
  });
}

/** Maps one token string to one userId; anything else fails to validate. */
function tokensFor(token: string, userId: string): TokenService {
  return {
    issue: async () => token,
    async validate(presented) {
      if (presented !== token) return { ok: false, error: "signature-invalid" };
      return { ok: true, value: { userId, issuedAt: 1, expiresAt: 9_999_999_999 } };
    },
  };
}

function storeReturning(result: StoreResult<UserRecord | null>) {
  return { get: async () => result };
}

function recordWithRole(role: UserRecord["role"]): StoreResult<UserRecord | null> {
  return {
    ok: true,
    value: {
      userId: KEVIN,
      displayName: "Kevin",
      pinHash: "$argon2id$fake",
      role,
      avatarTint: "terra",
      createdAt: "2026-08-07T00:00:00.000Z",
      credentialsValidFrom: "1970-01-01T00:00:00.000Z",
    },
  };
}

describe("buildRequireAdmin", () => {
  it("resolves the caller's role from the record, not from the token", async () => {
    const requireAdmin = buildRequireAdmin(
      tokensFor("kevin-token", KEVIN),
      undefined,
      storeReturning(recordWithRole("admin")),
    );

    expect(await requireAdmin(requestWith("Bearer kevin-token"))).toEqual({ ok: true, value: { role: "admin" } });
  });

  it("SECURITY: a demoted admin's unchanged token now resolves to the demoted role", async () => {
    const requireAdmin = buildRequireAdmin(
      tokensFor("kevin-token", KEVIN),
      undefined,
      storeReturning(recordWithRole("child")),
    );

    expect(await requireAdmin(requestWith("Bearer kevin-token"))).toEqual({ ok: true, value: { role: "child" } });
  });

  it("SECURITY: fails closed when the token names a user with no record", async () => {
    const requireAdmin = buildRequireAdmin(
      tokensFor("kevin-token", KEVIN),
      undefined,
      storeReturning({ ok: true, value: null }),
    );

    expect(await requireAdmin(requestWith("Bearer kevin-token"))).toEqual({ ok: false });
  });

  it("SECURITY: fails closed when the record store cannot answer", async () => {
    const requireAdmin = buildRequireAdmin(
      tokensFor("kevin-token", KEVIN),
      undefined,
      storeReturning({ ok: false, error: "io-error" }),
    );

    expect(await requireAdmin(requestWith("Bearer kevin-token"))).toEqual({ ok: false });
  });

  it("SECURITY: refuses a token that does not validate, without reading any record", async () => {
    let reads = 0;
    const requireAdmin = buildRequireAdmin(tokensFor("kevin-token", KEVIN), undefined, {
      get: async () => {
        reads += 1;
        return recordWithRole("admin");
      },
    });

    expect(await requireAdmin(requestWith("Bearer forged"))).toEqual({ ok: false });
    expect(reads).toBe(0);
  });

  it("refuses a request with no bearer header", async () => {
    const requireAdmin = buildRequireAdmin(
      tokensFor("kevin-token", KEVIN),
      undefined,
      storeReturning(recordWithRole("admin")),
    );

    expect(await requireAdmin(requestWith(null))).toEqual({ ok: false });
  });

  // The operator's out-of-band machine credential. Not a user at all, so there
  // is no record behind it to resolve and nothing to go stale.
  it("accepts the static ADMIN_TOKEN without consulting the record store", async () => {
    let reads = 0;
    const requireAdmin = buildRequireAdmin(tokensFor("kevin-token", KEVIN), STATIC_ADMIN_TOKEN, {
      get: async () => {
        reads += 1;
        return recordWithRole("child");
      },
    });

    expect(await requireAdmin(requestWith(`Bearer ${STATIC_ADMIN_TOKEN}`))).toEqual({
      ok: true,
      value: { role: "admin" },
    });
    expect(reads).toBe(0);
  });
});
