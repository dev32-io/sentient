import { randomBytes } from "node:crypto";
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
    const token = await svc.issue({ userId: "kevin", isAdmin: true });
    const r = await svc.validate(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userId).toBe("kevin");
      expect(r.value.isAdmin).toBe(true);
    }
  });

  it("embeds issuedAt and expiresAt", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 60 });
    const token = await svc.issue({ userId: "a", isAdmin: false });
    const r = await svc.validate(token);
    if (!r.ok) throw new Error("expected ok");
    const now = Math.floor(Date.now() / 1000);
    expect(r.value.issuedAt).toBe(now);
    expect(r.value.expiresAt).toBe(now + 60);
  });

  it("rejects an expired token", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 10 });
    const token = await svc.issue({ userId: "a", isAdmin: false });
    vi.advanceTimersByTime(15_000);
    const r = await svc.validate(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a token signed with a different secret", async () => {
    const svc1 = createTokenService({ secret, ttlSeconds: 60 });
    const svc2 = createTokenService({ secret: new Uint8Array(randomBytes(32)), ttlSeconds: 60 });
    const token = await svc1.issue({ userId: "a", isAdmin: false });
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
    const first = await svc.issue({ userId: "a", isAdmin: true });
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

  it("refresh refuses to extend an already-expired token", async () => {
    const svc = createTokenService({ secret, ttlSeconds: 10 });
    const token = await svc.issue({ userId: "a", isAdmin: false });
    vi.advanceTimersByTime(15_000);
    const r = await svc.refresh(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });
});
