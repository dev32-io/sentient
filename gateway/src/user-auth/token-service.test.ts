import { randomBytes } from "node:crypto";
import { encrypt } from "paseto-ts/v4";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialFloor } from "./credential-floor.js";
import { createTokenService } from "./token-service.js";

/** A floor stub. [ms] is the instant before which this user's tokens are dead;
 *  `null` models a token naming a user with no record at all. */
function floorAt(ms: number | null): CredentialFloor {
  return { validFromMsFor: async () => ms };
}

/** An account nothing has ever revoked — the epoch, which no real token can
 *  predate. What a freshly created record stores (`credential-floor.ts`). */
const credentialFloor = floorAt(0);

describe("createTokenService", () => {
  const secret = new Uint8Array(randomBytes(32));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a token and round-trips the userId", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600, credentialFloor });
    const token = await svc.issue({ userId: "kevin" });
    const r = await svc.validate(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userId).toBe("kevin");
    }
  });

  it("embeds issuedAt and expiresAt", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60, credentialFloor });
    const token = await svc.issue({ userId: "a" });
    const r = await svc.validate(token);
    if (!r.ok) throw new Error("expected ok");
    const now = Math.floor(Date.now() / 1000);
    expect(r.value.issuedAt).toBe(now);
    expect(r.value.expiresAt).toBe(now + 60);
  });

  it("rejects an expired token", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 10, credentialFloor });
    const token = await svc.issue({ userId: "a" });
    vi.advanceTimersByTime(15_000);
    const r = await svc.validate(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a token signed with a different secret", async () => {
    const svc1 = createTokenService({ secret, ttlSeconds: 60, credentialFloor });
    const svc2 = createTokenService({ secret: new Uint8Array(randomBytes(32)), ttlSeconds: 60, credentialFloor });
    const token = await svc1.issue({ userId: "a" });
    const r = await svc2.validate(token);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // either signature-invalid or malformed is acceptable depending on paseto-ts decoding path
      expect(["signature-invalid", "malformed"]).toContain(r.error);
    }
  });

  it("rejects a malformed token string", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60, credentialFloor });
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
    const svc = createTokenService({ secret, ttlSeconds: 60, credentialFloor });
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
    const svc = createTokenService({ secret, ttlSeconds: 3600, credentialFloor });
    const token = await svc.issue({ userId: "kevin" });
    const r = await svc.validate(token);
    if (!r.ok) throw new Error("expected ok");
    expect(Object.keys(r.value).sort()).toEqual(["expiresAt", "issuedAt", "userId"]);
  });

  it("accepts a legacy token carrying isAdmin, and never surfaces the claim", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600, credentialFloor });
    const r = await svc.validate(tokenWith({ isAdmin: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.userId).toBe("kevin");
    expect(Object.hasOwn(r.value, "isAdmin")).toBe(false);
  });

  it("accepts a token carrying a role claim, and never surfaces it either", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600, credentialFloor });
    const r = await svc.validate(tokenWith({ role: "admin" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.hasOwn(r.value, "role")).toBe(false);
  });

  // The attacker's shape: a hand-crafted claim naming a privilege. It cannot be
  // forged without the key, but even WITH the key it buys nothing, because no
  // authorization decision anywhere reads a claim.
  it("ignores an invented privilege claim rather than being confused by it", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600, credentialFloor });
    const r = await svc.validate(tokenWith({ role: "superadmin", isAdmin: true, scope: "*" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(["expiresAt", "issuedAt", "userId"]);
  });

  it("still enforces the purpose claim, which is not authority but binding", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600, credentialFloor });
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

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — A REVOKED CREDENTIAL STOPS VALIDATING.
//
// The token still decrypts, still carries the right purpose and is nowhere near
// its `exp`. It is refused anyway, because the RECORD says every token this
// account holds from before the revocation instant is dead. One choke point,
// read at the moment of the decision, covering all 17 `validate()` call sites —
// which is what makes a role change take effect with no refresh, no re-login
// and no cache to flush.
// ---------------------------------------------------------------------------
describe("the credential floor read from the record", () => {
  const secret = new Uint8Array(randomBytes(32));
  const TTL_SECONDS = 3600;
  const MS_PER_SECOND = 1000;

  /** A live token plus the millisecond its `issuedAt` second STARTS at — the
   *  value the floor is compared against, so every case below is stated as an
   *  offset from the exact tie. */
  async function freshToken() {
    const issuing = createTokenService({ secret, ttlSeconds: TTL_SECONDS, credentialFloor: floorAt(0) });
    const token = await issuing.issue({ userId: "kevin" });
    const r = await issuing.validate(token);
    if (!r.ok) throw new Error("expected a freshly issued token to validate");
    return { token, tieMs: r.value.issuedAt * MS_PER_SECOND };
  }

  /** Validate a live token against a floor [offsetMs] from the tie. */
  async function validateWithFloorOffset(offsetMs: number) {
    const { token, tieMs } = await freshToken();
    const svc = createTokenService({ secret, ttlSeconds: TTL_SECONDS, credentialFloor: floorAt(tieMs + offsetMs) });
    return svc.validate(token);
  }

  /** Validate a live token whose user has no record at all. */
  async function validateWithNoRecord() {
    const { token } = await freshToken();
    const svc = createTokenService({ secret, ttlSeconds: TTL_SECONDS, credentialFloor: floorAt(null) });
    return svc.validate(token);
  }

  it("SECURITY: refuses a token issued before the account's credentials were revoked", async () => {
    expect(await validateWithFloorOffset(5 * MS_PER_SECOND)).toEqual({ ok: false, error: "expired" });
  });

  // FAIL CLOSED ON THE TIE. `issuedAt` is unix SECONDS and the floor is a
  // millisecond instant, so "issued in the same second as the revocation" is
  // indistinguishable from "issued just before it". The token loses.
  it("SECURITY: refuses a token whose issuing second is the revocation instant itself", async () => {
    expect(await validateWithFloorOffset(0)).toEqual({ ok: false, error: "expired" });
  });

  it("SECURITY: refuses a token issued in the same second as a revocation later in that second", async () => {
    expect(await validateWithFloorOffset(MS_PER_SECOND - 1)).toEqual({ ok: false, error: "expired" });
  });

  it("accepts a token issued after the revocation instant", async () => {
    const r = await validateWithFloorOffset(-1);
    expect(r.ok).toBe(true);
  });

  // A token naming a user who is not there identifies nobody. Never a defaulted
  // floor, never a permissive fallback — the same refusal as a revoked one.
  it("SECURITY: refuses the token when the record is gone rather than defaulting a floor", async () => {
    expect(await validateWithNoRecord()).toEqual({ ok: false, error: "expired" });
  });

  // WIRE CONTRACT. `expired` is already terminal on all three clients (web's
  // router classifies any auth.error frame terminal; mobile's
  // TERMINAL_AUTH_CODES lists `expired`), so this routes to the login screen. A
  // new code would be terminal on the auth.error path but fall off mobile's
  // sessions allow-list and retry forever.
  it("WIRE: a revocation reuses `expired`, never a new TokenError the clients cannot classify", async () => {
    const revoked = await validateWithFloorOffset(MS_PER_SECOND);
    const noRecord = await validateWithNoRecord();
    expect(revoked).toEqual(noRecord);
    if (revoked.ok) throw new Error("expected a refusal");
    expect(revoked.error).toBe("expired");
  });
});
