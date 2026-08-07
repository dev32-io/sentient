import { describe, expect, it } from "bun:test";
import { profileV1Schema } from "./profile-types.js";

const BASE = {
  schemaVersion: 1,
  userId: "u_aaaaaaaa",
  model: { provider: "ollama-cloud", id: "gpt-oss:20b" },
  voice: { provider: "local-tts", id: "default" },
  persona: { template: "default", overrides: "" },
  // Required fields with no schema default — not part of the brief's
  // illustrative fixture, added here so BASE parses at all.
  compression: { threshold: 0.5 },
  advanced: { extraSystemPrompt: "", maxTokens: 1024 },
};

describe("profile tools.permissions", () => {
  it("migrates a legacy tools.enabled map into per-tool permissions", () => {
    const parsed = profileV1Schema.parse({
      ...BASE,
      tools: { enabled: { home_assistant: [], searxng: ["web_search"] }, toolsets: ["memory"] },
    });
    // An enabled server with an empty narrowing inherits: no explicit entries.
    expect(parsed.tools.permissions?.home_assistant).toEqual({});
    // A narrowed server keeps its named tools inheriting and says nothing about
    // the rest — the catalog decides what else exists, and unnamed tools go off.
    expect(parsed.tools.permissions?.searxng?.web_search).toBeUndefined();
    // `enabled` no longer exists on ProfileV1["tools"]'s type at all; cast to
    // check the parsed runtime object actually dropped the key too (guards
    // against a future zod `.passthrough()` accidentally leaking it back in).
    expect((parsed.tools as Record<string, unknown>).enabled).toBeUndefined();
  });

  it("accepts an explicit permissions map and rejects an unknown member", () => {
    const parsed = profileV1Schema.parse({
      ...BASE,
      tools: { permissions: { home_assistant: { ha_search: "ask", ha_call_service: "off" } } },
    });
    expect(parsed.tools.permissions?.home_assistant?.ha_search).toBe("ask");
    expect(() => profileV1Schema.parse({ ...BASE, tools: { permissions: { s: { t: "auto" } } } })).toThrow();
  });
});
