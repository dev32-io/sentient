import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApi } from "../services/admin-api.ts";
import { createAuthApi } from "../services/auth-api.ts";
import { createProfileApi } from "../services/profile-api.ts";
import { createProvidersApi } from "../services/providers-api.ts";
import { createVoicesApi } from "../services/voices-api.ts";
import { createProductReviewFetch, createReviewStorage, reviewProfile } from "./product-review-fixtures.ts";

afterEach(() => vi.unstubAllGlobals());
describe("standalone product review boundary", () => {
  it("denies unknown, absolute external, audio and mutation requests without delegating", async () => {
    const fetch = createProductReviewFetch();
    for (const url of [
      "https://example.com/api/v1/profile/me",
      "/api/v1/private",
      "/api/v1/voices/review-voice/preview",
    ]) {
      expect((await fetch(url)).status).toBe(403);
    }
    expect((await fetch("/api/v1/admin/users", { method: "POST", body: "{}" })).status).toBe(403);
  });
  it("uses actual service response contracts and keeps profile mutations in this fixture instance", async () => {
    vi.stubGlobal("fetch", createProductReviewFetch());
    const profile = createProfileApi();
    const next = { ...reviewProfile, audio: { ttsEnabled: true, channel: "text" as const } };
    expect(await profile.updateMe("fixture", next)).toEqual({ ok: true, value: next });
    expect(await profile.getMe("fixture")).toEqual({ ok: true, value: next });
    expect((await profile.getMemoryDoc("fixture", "memory")).ok).toBe(true);
    expect((await profile.getMcpCatalog("fixture")).ok).toBe(true);
    expect((await createProvidersApi().listModels("fixture")).ok).toBe(true);
    expect((await createVoicesApi().listVoices("fixture")).ok).toBe(true);
    const auth = await createAuthApi().me("fixture");
    expect(auth.ok && auth.value.user.role).toBe("admin");
    expect((await createAdminApi().getSecretsStatus("fixture")).ok).toBe(true);
    vi.stubGlobal("fetch", createProductReviewFetch("populated", false));
    expect(await createAdminApi().listUsers("fixture")).toEqual({
      ok: false,
      error: { status: 403, code: "forbidden" },
    });
    expect(await profile.getMe("fixture")).toEqual({ ok: true, value: reviewProfile });
  });
  it("isolates auth storage and provides real empty/error list contracts", async () => {
    const storage = createReviewStorage();
    storage.setItem("sentient:auth", "fictional");
    expect(createReviewStorage().getItem("sentient:auth")).toBeNull();
    vi.stubGlobal("fetch", createProductReviewFetch("empty"));
    expect(await createAuthApi().listUsers()).toEqual({ ok: true, value: [] });
    vi.stubGlobal("fetch", createProductReviewFetch("error"));
    expect(await createAuthApi().listUsers()).toEqual({
      ok: false,
      error: { status: 503, code: "qa-fixture-unavailable" },
    });
  });
});
