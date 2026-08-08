import type { UserRole } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import type { TokenService } from "../../user-auth/token-service.ts";
import type { StoreResult, TokenPayload, TokenResult, UserRecord } from "../../user-auth/types.ts";
import type { UserStore } from "../../user-auth/user-store.ts";
import { requireAdminAuth } from "./require-admin-auth.ts";

const FAR_FUTURE = 9_999_999_999;

function fakeTokenService(validate: (token: string) => TokenResult<TokenPayload>): TokenService {
  return {
    issue: async () => "stub",
    validate: async (token) => validate(token),
  };
}

/** The whole payload now. Note what it CANNOT say: anything about authority. */
function identifies(userId: string): TokenPayload {
  return { userId, issuedAt: 0, expiresAt: FAR_FUTURE };
}

function record(userId: string, role: UserRole): UserRecord {
  return {
    userId,
    displayName: userId,
    pinHash: "$argon2id$fake",
    role,
    avatarTint: "terra",
    createdAt: "2026-08-07T00:00:00.000Z",
  };
}

/** A mutable stand-in for users.json — `set` is what "an admin demotes her"
 *  looks like from this test's point of view. */
function fakeUserStore(initial: UserRecord | null): Pick<UserStore, "get"> & { set(next: UserRecord | null): void } {
  let stored = initial;
  return {
    async get(): Promise<StoreResult<UserRecord | null>> {
      return { ok: true, value: stored };
    },
    set(next) {
      stored = next;
    },
  };
}

function erroringUserStore(): Pick<UserStore, "get"> {
  return {
    async get(): Promise<StoreResult<UserRecord | null>> {
      return { ok: false, error: "io-error" };
    },
  };
}

function adminRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://test/api/v1/admin/ping", { headers });
}

const NO_USERS = fakeUserStore(null);

describe("requireAdminAuth", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const guard = requireAdminAuth({ adminToken: "secret", userStore: NO_USERS });
    const res = await guard(adminRequest());
    expect(res?.status).toBe(401);
  });

  it("returns 401 when the static token is wrong and no session service is configured", async () => {
    const guard = requireAdminAuth({ adminToken: "secret", userStore: NO_USERS });
    const res = await guard(adminRequest("nope"));
    expect(res?.status).toBe(401);
  });

  it("returns undefined (pass-through) when the static token matches", async () => {
    const guard = requireAdminAuth({ adminToken: "secret", userStore: NO_USERS });
    const res = await guard(adminRequest("secret"));
    expect(res).toBeUndefined();
  });

  it("returns 503 when neither static token nor session service is configured", async () => {
    const guard = requireAdminAuth({ adminToken: undefined, userStore: NO_USERS });
    const res = await guard(adminRequest("anything"));
    expect(res?.status).toBe(503);
  });

  it("returns undefined when the token names a user whose record says admin", async () => {
    const tokenService = fakeTokenService((token) =>
      token === "session-tok" ? { ok: true, value: identifies("u_admin") } : { ok: false, error: "signature-invalid" },
    );
    const userStore = fakeUserStore(record("u_admin", "admin"));
    const guard = requireAdminAuth({ adminToken: undefined, tokenService, userStore });
    expect(await guard(adminRequest("session-tok"))).toBeUndefined();
  });

  it("returns 403 when the token names a user whose record says anything else", async () => {
    const tokenService = fakeTokenService(() => ({ ok: true, value: identifies("u_member") }));
    const userStore = fakeUserStore(record("u_member", "adult"));
    const guard = requireAdminAuth({ adminToken: undefined, tokenService, userStore });
    const res = await guard(adminRequest("session-tok"));
    expect(res?.status).toBe(403);
  });

  it("returns 401 when no static token matches and the PASETO token is invalid", async () => {
    const tokenService = fakeTokenService(() => ({ ok: false, error: "signature-invalid" }));
    const guard = requireAdminAuth({ adminToken: "secret", tokenService, userStore: NO_USERS });
    const res = await guard(adminRequest("not-the-secret"));
    expect(res?.status).toBe(401);
  });

  it("accepts the static token even when a session service is also configured", async () => {
    const tokenService = fakeTokenService(() => ({ ok: false, error: "signature-invalid" }));
    const guard = requireAdminAuth({ adminToken: "secret", tokenService, userStore: NO_USERS });
    expect(await guard(adminRequest("secret"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT, AND THE ATTACK IT DEFEATS.
//
// Owner ruling, 2026-08-07, verbatim:
//
//   "a minimum token is simply enough for client to id and communicate with the
//    server, then server ALWAYS pulls user role/user scope freshly at runtime
//    which means a stale token could simply trigger a invalidation of token. At
//    an attack senario, when someone use a demoted user token to try to gain
//    previous admin permission, this would still fail as the token is used for
//    server to identify user AND identify what the user and role scope is
//    internally, not by trusting a token"
//
// That scenario, executed literally: ONE token, issued while the holder was an
// admin, never re-presented for refresh, never re-issued, never invalidated.
// The record changes underneath it and the very next request is refused.
//
// This is the test that would have caught every version of the bug this route
// has had. It fails if anyone ever re-introduces a role claim, caches the
// lookup, or reads authority from the credential.
// ---------------------------------------------------------------------------
describe("a token issued while its holder was an admin, after the demotion", () => {
  const ADMIN_ID = "u_a1b2c3d4";
  const TOKEN = "issued-while-she-was-admin";

  function guardOver(userStore: Pick<UserStore, "get">) {
    const tokenService = fakeTokenService((token) =>
      token === TOKEN ? { ok: true, value: identifies(ADMIN_ID) } : { ok: false, error: "signature-invalid" },
    );
    return requireAdminAuth({ adminToken: undefined, tokenService, userStore });
  }

  it("opens the admin surface while the record still says admin", async () => {
    expect(await guardOver(fakeUserStore(record(ADMIN_ID, "admin")))(adminRequest(TOKEN))).toBeUndefined();
  });

  it("is refused on the FIRST request after the demotion — same token, no refresh, no re-login", async () => {
    const userStore = fakeUserStore(record(ADMIN_ID, "admin"));
    const guard = guardOver(userStore);

    // She is an admin, and the door opens.
    expect(await guard(adminRequest(TOKEN))).toBeUndefined();

    // An admin demotes her. Nothing touches her token — it is still in her
    // browser, still unexpired, still cryptographically valid.
    userStore.set(record(ADMIN_ID, "adult"));

    // The next request. Same guard instance (so no cache can hide behind a
    // rebuild), same token, no interaction of any kind in between.
    const res = await guard(adminRequest(TOKEN));
    expect(res?.status).toBe(403);
  });

  it("stays refused however many times she retries", async () => {
    const userStore = fakeUserStore(record(ADMIN_ID, "admin"));
    const guard = guardOver(userStore);
    await guard(adminRequest(TOKEN));
    userStore.set(record(ADMIN_ID, "guest"));
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await guard(adminRequest(TOKEN)))?.status).toBe(403);
    }
  });

  it("regains the surface the moment the record says admin again — no re-login either", async () => {
    const userStore = fakeUserStore(record(ADMIN_ID, "adult"));
    const guard = guardOver(userStore);
    expect((await guard(adminRequest(TOKEN)))?.status).toBe(403);
    userStore.set(record(ADMIN_ID, "admin"));
    expect(await guard(adminRequest(TOKEN))).toBeUndefined();
  });

  // FAIL CLOSED. A token naming a user who is not there identifies nobody, so
  // it is an invalid credential — never a defaulted role.
  it("returns 401, not a defaulted role, when the named user has no record", async () => {
    const res = await guardOver(fakeUserStore(null))(adminRequest(TOKEN));
    expect(res?.status).toBe(401);
  });

  it("returns 401, not a defaulted role, when the record cannot be read at all", async () => {
    const res = await guardOver(erroringUserStore())(adminRequest(TOKEN));
    expect(res?.status).toBe(401);
  });
});
