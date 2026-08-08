import { describe, expect, it } from "vitest";
import type { TokenService } from "../../user-auth/token-service.ts";
import type { TokenPayload, TokenResult } from "../../user-auth/types.ts";
import { requireAdminAuth } from "./require-admin-auth.ts";

const FAR_FUTURE = 9_999_999_999;

function fakeTokenService(validate: (token: string) => TokenResult<TokenPayload>): TokenService {
  return {
    issue: async () => "stub",
    validate: async (token) => validate(token),
  };
}

function adminPayload(userId: string): TokenPayload {
  return { userId, role: "admin", issuedAt: 0, expiresAt: FAR_FUTURE };
}

function memberPayload(userId: string): TokenPayload {
  return { userId, role: "adult", issuedAt: 0, expiresAt: FAR_FUTURE };
}

function adminRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://test/api/v1/admin/ping", { headers });
}

describe("requireAdminAuth", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const guard = requireAdminAuth({ adminToken: "secret" });
    const res = await guard(adminRequest());
    expect(res?.status).toBe(401);
  });

  it("returns 401 when the static token is wrong and no session service is configured", async () => {
    const guard = requireAdminAuth({ adminToken: "secret" });
    const res = await guard(adminRequest("nope"));
    expect(res?.status).toBe(401);
  });

  it("returns undefined (pass-through) when the static token matches", async () => {
    const guard = requireAdminAuth({ adminToken: "secret" });
    const res = await guard(adminRequest("secret"));
    expect(res).toBeUndefined();
  });

  it("returns 503 when neither static token nor session service is configured", async () => {
    const guard = requireAdminAuth({ adminToken: undefined });
    const res = await guard(adminRequest("anything"));
    expect(res?.status).toBe(503);
  });

  it("returns undefined when a PASETO session token resolves to an admin user", async () => {
    const tokenService = fakeTokenService((token) =>
      token === "session-tok"
        ? { ok: true, value: adminPayload("u_admin") }
        : { ok: false, error: "signature-invalid" },
    );
    const guard = requireAdminAuth({ adminToken: undefined, tokenService });
    const res = await guard(adminRequest("session-tok"));
    expect(res).toBeUndefined();
  });

  it("returns 403 when a PASETO session token resolves to a non-admin user", async () => {
    const tokenService = fakeTokenService(() => ({ ok: true, value: memberPayload("u_member") }));
    const guard = requireAdminAuth({ adminToken: undefined, tokenService });
    const res = await guard(adminRequest("session-tok"));
    expect(res?.status).toBe(403);
  });

  it("returns 401 when no static token matches and the PASETO token is invalid", async () => {
    const tokenService = fakeTokenService(() => ({ ok: false, error: "signature-invalid" }));
    const guard = requireAdminAuth({ adminToken: "secret", tokenService });
    const res = await guard(adminRequest("not-the-secret"));
    expect(res?.status).toBe(401);
  });

  it("accepts the static token even when a session service is also configured", async () => {
    const tokenService = fakeTokenService(() => ({ ok: false, error: "signature-invalid" }));
    const guard = requireAdminAuth({ adminToken: "secret", tokenService });
    const res = await guard(adminRequest("secret"));
    expect(res).toBeUndefined();
  });
});
