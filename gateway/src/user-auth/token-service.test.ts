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

  it("issues a token and round-trips the payload", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    const token = await svc.issue({ userId: "kevin", role: "admin" });
    const r = await svc.validate(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userId).toBe("kevin");
      expect(r.value.role).toBe("admin");
    }
  });

  it("embeds issuedAt and expiresAt", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60 });
    const token = await svc.issue({ userId: "a", role: "adult" });
    const r = await svc.validate(token);
    if (!r.ok) throw new Error("expected ok");
    const now = Math.floor(Date.now() / 1000);
    expect(r.value.issuedAt).toBe(now);
    expect(r.value.expiresAt).toBe(now + 60);
  });

  it("rejects an expired token", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 10 });
    const token = await svc.issue({ userId: "a", role: "adult" });
    vi.advanceTimersByTime(15_000);
    const r = await svc.validate(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a token signed with a different secret", async () => {
    const svc1 = createTokenService({ secret, ttlSeconds: 60 });
    const svc2 = createTokenService({ secret: new Uint8Array(randomBytes(32)), ttlSeconds: 60 });
    const token = await svc1.issue({ userId: "a", role: "adult" });
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

  it("refresh extends the expiry without changing userId", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60 });
    const first = await svc.issue({ userId: "a", role: "admin" });
    vi.advanceTimersByTime(30_000);
    const refreshed = await svc.refresh(first);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    const parsed = await svc.validate(refreshed.value);
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value.userId).toBe("a");
    const now = Math.floor(Date.now() / 1000);
    expect(parsed.value.expiresAt).toBe(now + 60);
  });

  it("refresh carries the role forward rather than re-deriving it", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60 });
    const first = await svc.issue({ userId: "a", role: "child" });
    const refreshed = await svc.refresh(first);
    if (!refreshed.ok) throw new Error("expected ok");
    const parsed = await svc.validate(refreshed.value);
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value.role).toBe("child");
  });

  it("refresh refuses to extend an already-expired token", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 10 });
    const token = await svc.issue({ userId: "a", role: "adult" });
    vi.advanceTimersByTime(15_000);
    const r = await svc.refresh(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });
});

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — the role claim, and what a token minted before it existed
// must do (plan 2026-08-07-tool-permissions, task 2b).
//
// Every token issued before this task carries `isAdmin` and no `role`. It is
// otherwise perfectly valid: right key, right purpose, unexpired. Defaulting
// its missing role to anything is a decision about somebody's authority made
// from a claim that is not in the token — `admin` would be outright privilege
// escalation and `adult` would still hand a demoted account a tier it lost. So
// a roleless token is REFUSED and its holder re-authenticates.
//
// It is refused as `malformed`, an EXISTING TokenError, deliberately: all three
// clients already classify that code as terminal and route to login
// (`AuthErrorClass.kt`'s TERMINAL_AUTH_CODES; the auth.error frame path is
// terminal-by-default). A brand-new code would fall off mobile's sessions-error
// allow-list and loop instead of logging the user out.
// ---------------------------------------------------------------------------
describe("a token minted before the role claim existed", () => {
  const secret = new Uint8Array(randomBytes(32));
  const localKey = `k4.local.${Buffer.from(secret).toString("base64url")}`;
  const PURPOSE = "sentient.user-session.v1";

  /** Mints the exact claim set `token-service.ts` issued before this task. */
  function legacyToken(claims: Record<string, unknown>): string {
    const iat = new Date();
    const exp = new Date(iat.getTime() + 3_600_000);
    return encrypt(
      localKey,
      { sub: "kevin", purpose: PURPOSE, iat: iat.toISOString(), exp: exp.toISOString(), ...claims },
      { addIat: false, addExp: false },
    );
  }

  it("is refused when it carries no role claim at all", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    expect(await svc.validate(legacyToken({ isAdmin: false }))).toEqual({ ok: false, error: "malformed" });
  });

  it("is refused rather than promoted, even when its isAdmin claim was true", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    expect(await svc.validate(legacyToken({ isAdmin: true }))).toEqual({ ok: false, error: "malformed" });
  });

  it("is refused when its role claim is not a known role", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    expect(await svc.validate(legacyToken({ role: "superadmin" }))).toEqual({ ok: false, error: "malformed" });
  });

  it("cannot be refreshed into a valid one", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 3600 });
    expect(await svc.refresh(legacyToken({ isAdmin: true }))).toEqual({ ok: false, error: "malformed" });
  });
});
