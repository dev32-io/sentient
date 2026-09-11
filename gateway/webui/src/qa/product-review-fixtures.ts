import type { AuthUser } from "../services/auth-api.ts";
import type { ProfileV1 } from "../services/profile-api.ts";

export const reviewUser: AuthUser = {
  userId: "review-robin",
  displayName: "Robin",
  avatarTint: "sage",
  role: "admin",
  isAdmin: true,
};
export const reviewProfile: ProfileV1 = {
  schemaVersion: 1,
  userId: reviewUser.userId,
  model: { provider: "custom", id: "review-model" },
  voice: { provider: "local-tts", id: "review-voice" },
  audio: { ttsEnabled: false, channel: "text" },
  memory: { spark: true, dreaming: false },
  persona: { template: "default", overrides: "" },
  tools: { toolsets: ["memory"] },
  compression: { threshold: 0.8 },
  advanced: { extraSystemPrompt: "", maxTokens: 4096, reasoningEffort: "minimal" },
};

export function createReviewStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/** No reference to native fetch. Unknown reads AND writes fail closed. Bodies are never logged. */
export function createProductReviewFetch(state = "populated", admin = true): typeof fetch {
  let profile = structuredClone(reviewProfile);
  let user = { ...reviewUser, isAdmin: admin, role: admin ? ("admin" as const) : ("adult" as const) };
  const docs: Record<string, string> = {
    soul: "Be kind, clear, and helpful.",
    "memory/memory": "Robin enjoys fictional garden projects.",
    "memory/user": "Use short, friendly explanations.",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://review.invalid",
    );
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== "http://review.invalid") return json({ error: "qa-request-denied" }, 403);
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    if (path.startsWith("admin/") && !admin) return json({ error: "forbidden" }, 403);
    const body = () => JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (method === "PUT" && path === "profile/me") {
      profile = body();
      return json(profile);
    }
    if (method === "PUT" && path === "auth/me") {
      user = { ...user, displayName: body().displayName };
      return json({ token: "fictional-review-token", user });
    }
    if (method === "PUT" && path.startsWith("profile/") && path.slice(8) in docs) {
      docs[path.slice(8)] = body().content;
      return json({ state: "ready", elapsedMs: 0 });
    }
    if (method === "POST" && path === "profile/apply") return json({ status: "ready", elapsedMs: 0 });
    if (method !== "GET") return json({ error: "qa-mutation-unavailable" }, 403);
    if (path === "auth/me") return json({ token: "fictional-review-token", user });
    if (path === "profile/me") return json(profile);
    if (state === "error") return json({ error: "qa-fixture-unavailable" }, 503);
    if (state === "loading") await new Promise((resolve) => setTimeout(resolve, 8000)); // bounded observation window
    const empty = state === "empty";
    if (path.startsWith("profile/") && path.slice(8) in docs)
      return json({ content: empty ? "" : docs[path.slice(8)], lastModified: null, charLimit: 8000 });
    const routes: Record<string, unknown> = {
      "auth/users": empty ? [] : [reviewUser, { userId: "review-jules", displayName: "Jules", avatarTint: "terra" }],
      "profile/soul/default": { content: "Be kind, clear, and helpful." },
      "profile/personalities": {
        personalities: empty ? [] : [{ name: "Thoughtful", body: "Offer calm, practical suggestions." }],
        activeName: null,
      },
      "providers/models": {
        models: empty
          ? []
          : [
              {
                id: "review-model",
                provider: "custom",
                name: "Garden model",
                description: "Fictional review model",
                contextLength: 32000,
                pricingPer1mPrompt: "included",
                pricingPer1mCompletion: "included",
                supportsTools: true,
                supportsVision: false,
              },
            ],
        stale: false,
      },
      voices: {
        voices: empty
          ? []
          : [
              {
                voiceId: "review-voice",
                name: "Willow",
                description: "Fictional warm voice",
                tags: ["calm"],
                language: "en",
                source: "builtin",
                createdAt: 0,
                refDurationMs: 0,
              },
            ],
      },
      "mcp-catalog": {
        groups: empty
          ? {}
          : {
              skills: {
                defaultExposure: "standard",
                wildcardPermission: null,
                tools: [
                  {
                    name: "review_notes",
                    description: "Read fictional garden notes",
                    tier: "read",
                    permission: "allow",
                    settable: true,
                    dispatch: { kind: "native" },
                  },
                ],
              },
            },
        wildcardPermissionKey: "*",
        hermesBuiltins: empty ? [] : [{ name: "memory", description: "Recall fictional notes", toolset: "memory" }],
      },
      "admin/users": { users: empty ? [] : [{ ...user, slotKey: "review", createdAt: "2026-01-01T00:00:00Z" }] },
      "admin/secrets": {
        llm: {
          active: "custom",
          custom: { has_key: false, has_base_url: false },
          openrouter: { has_key: false, has_base_url: false },
          ollama_cloud: { has_key: false, has_base_url: false },
        },
        home_assistant: { observe_token: { has_token: false }, mcp_server_token: { has_token: false } },
        music_assistant: { has_token: false },
      },
      "system/apply-status": { state: "ready", services: [] },
      "services/versions": {
        gateway: "0.0.0-review",
        hermes: "unknown",
        stt_service: "unknown",
        tts_service: "unknown",
        features: { fish_browse_enabled: false },
      },
    };
    return path in routes ? json(routes[path]) : json({ error: "qa-request-denied" }, 403);
  }) as typeof fetch;
}
