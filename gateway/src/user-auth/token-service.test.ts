import { randomBytes } from "node:crypto";
import { encrypt } from "paseto-ts/v4";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenService } from "./token-service.js";

describe("createTokenService", () => {
  const secret = new Uint8Array(randomBytes(32));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a token and round-trips the userId", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    const token = await svc.issue({ userId: "kevin" });
    const r = await svc.validate(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userId).toBe("kevin");
    }
  });

  it("embeds issuedAt and expiresAt", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60 });
    const token = await svc.issue({ userId: "a" });
    const r = await svc.validate(token);
    if (!r.ok) throw new Error("expected ok");
    const now = Math.floor(Date.now() / 1000);
    expect(r.value.issuedAt).toBe(now);
    expect(r.value.expiresAt).toBe(now + 60);
  });

  it("rejects an expired token", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 10 });
    const token = await svc.issue({ userId: "a" });
    vi.advanceTimersByTime(15_000);
    const r = await svc.validate(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a token signed with a different secret", async () => {
    const svc1 = createTokenService({ secret, ttlSeconds: 60 });
    const svc2 = createTokenService({ secret: new Uint8Array(randomBytes(32)), ttlSeconds: 60 });
    const token = await svc1.issue({ userId: "a" });
    const r = await svc2.validate(token);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // either signature-invalid or malformed is acceptable depending on paseto-ts decoding path
      expect(["signature-invalid", "malformed"]).toContain(r.error);
    }
  });

  it("rejects a malformed token string", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60 });
    const r = await svc.validate("not-a-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["malformed", "signature-invalid"]).toContain(r.error);
    }
  });

  // SECURITY BOUNDARY — there is no token-rolling method, and there must not
  // be one. A roll re-mints from the presented token's own claims, which is
  // exactly the "trusting a token" the owner's ruling forbids. Renewal reads
  // the user record and calls `issue` (`api/handlers/auth.ts#handleMe`).
  it("exposes no way to mint a token from another token", () => {
    const svc = createTokenService({ secret, ttlSeconds: 60 });
    expect(Object.keys(svc).sort()).toEqual(["issue", "validate"]);
  });
});

// ---------------------------------------------------------------------------
// WIRE CONTRACT — THE TOKEN IDENTIFIES, IT NEVER AUTHORIZES.
//
// Owner ruling, 2026-08-07: "a minimum token is simply enough for client to id
// and communicate with the server, then server ALWAYS pulls user role/user
// scope freshly at runtime". So the claim set is `sub`/`purpose`/`iat`/`exp`
// and the payload this service hands back says nothing about authority — there
// is no field for a caller to be tempted by.
//
// The second half matters as much as the first: a token minted by an OLDER
// revision carries authority claims (`isAdmin`, or the short-lived `role` from
// an intermediate revision). Those tokens stay VALID — their holder is not
// logged out — and their extra claims are never read, so holding one buys
// nothing. Refusing them would have forced a household-wide re-login to fix a
// problem that the design change already made impossible.
// ---------------------------------------------------------------------------
describe("what a validated token is allowed to tell the gateway", () => {
  const secret = new Uint8Array(randomBytes(32));
  const localKey = `k4.local.${Buffer.from(secret).toString("base64url")}`;
  const PURPOSE = "sentient.user-session.v1";

  /** Mints a token with arbitrary extra claims — i.e. what an older revision
   *  of this service, or an over-helpful future one, would produce. */
  function tokenWith(extra: Record<string, unknown>): string {
    const iat = new Date();
    const exp = new Date(iat.getTime() + 3_600_000);
    return encrypt(
      localKey,
      { sub: "kevin", purpose: PURPOSE, iat: iat.toISOString(), exp: exp.toISOString(), ...extra },
      { addIat: false, addExp: false },
    );
  }

  it("carries identity and lifetime, and nothing that looks like authority", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    const token = await svc.issue({ userId: "kevin" });
    const r = await svc.validate(token);
    if (!r.ok) throw new Error("expected ok");
    expect(Object.keys(r.value).sort()).toEqual(["expiresAt", "issuedAt", "userId"]);
  });

  it("accepts a legacy token carrying isAdmin, and never surfaces the claim", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    const r = await svc.validate(tokenWith({ isAdmin: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.userId).toBe("kevin");
    expect(Object.hasOwn(r.value, "isAdmin")).toBe(false);
  });

  it("accepts a token carrying a role claim, and never surfaces it either", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    const r = await svc.validate(tokenWith({ role: "admin" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.hasOwn(r.value, "role")).toBe(false);
  });

  // The attacker's shape: a hand-crafted claim naming a privilege. It cannot be
  // forged without the key, but even WITH the key it buys nothing, because no
  // authorization decision anywhere reads a claim.
  it("ignores an invented privilege claim rather than being confused by it", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    const r = await svc.validate(tokenWith({ role: "superadmin", isAdmin: true, scope: "*" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(["expiresAt", "issuedAt", "userId"]);
  });

  it("still enforces the purpose claim, which is not authority but binding", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    const iat = new Date();
    const wrongPurpose = encrypt(
      localKey,
      {
        sub: "kevin",
        purpose: "some.other.v1",
        iat: iat.toISOString(),
        exp: new Date(iat.getTime() + 3_600_000).toISOString(),
      },
      { addIat: false, addExp: false },
    );
    expect(await svc.validate(wrongPurpose)).toEqual({ ok: false, error: "wrong-purpose" });
  });
});
