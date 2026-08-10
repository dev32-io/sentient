import { describe, expect, it } from "bun:test";
import { profileV1PutBodySchema, profileV1Schema } from "./profile-types.js";

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

  // The two empties. Collapsing them is how every account-creation path in the
  // product came to hand new users a profile with zero MCP tools: the web
  // wizard and the mobile admin screen both POST `tools: { enabled: {} }`, and
  // emitting `permissions: {}` for it made `applyProfileDefaults` see a field
  // that was already set and decline to seed the starter servers.
  it("migrates an EMPTY tools.enabled to UNSET, so the defaults layer still seeds", () => {
    const parsed = profileV1Schema.parse({ ...BASE, tools: { enabled: {}, toolsets: [] } });

    expect(parsed.tools.permissions).toBeUndefined();
  });

  it("leaves an EXPLICIT empty permissions map alone — that one IS a deliberate everything-off", () => {
    const parsed = profileV1Schema.parse({ ...BASE, tools: { permissions: {}, toolsets: [] } });

    expect(parsed.tools.permissions).toEqual({});
  });

  it("migrates the doubly-legacy empty tools.enabled ARRAY to UNSET too", () => {
    const parsed = profileV1Schema.parse({ ...BASE, tools: { enabled: [], toolsets: [] } });

    expect(parsed.tools.permissions).toBeUndefined();
  });

  it("accepts an explicit permissions map and rejects an unknown member", () => {
    const parsed = profileV1Schema.parse({
      ...BASE,
      tools: { permissions: { home_assistant: { ha_search: "ask", ha_call_service: "off" } } },
    });
    expect(parsed.tools.permissions?.home_assistant?.ha_search).toBe("ask");
    expect(() => profileV1Schema.parse({ ...BASE, tools: { permissions: { s: { t: "auto" } } } })).toThrow();
  });

  // `profileV1Schema` itself (the STORED shape) rejects `null` outright — it
  // is what `readStoredProfile`/`ProfileStore.get` validate a persisted
  // profile.json against, and a `null` leaf must never survive a save
  // (`profile-update.ts#mergeServer` strips every clear before anything is
  // written back). If this schema ever started accepting `null`, a clear
  // could reach disk unresolved instead of collapsing to an absent key.
  it("the STORED schema rejects a null permission leaf", () => {
    expect(() =>
      profileV1Schema.parse({ ...BASE, tools: { permissions: { household: { look_up: null } } } }),
    ).toThrow();
  });
});

// `profileV1PutBodySchema` is what a `PUT /api/v1/profile/me` BODY is parsed
// against — identical to `profileV1Schema` except a permission leaf may also
// be `null` (a CLEAR — see `ToolPermissionOrClear`'s doc comment). These pin
// the schema itself, at the actual JSON-parsing boundary, separately from
// `profile-update.test.ts`'s pure-function tests (which hand-construct
// already-typed objects and so never exercise zod at all).
describe("profile PUT body accepts a null permission leaf", () => {
  it("accepts null as a valid per-tool value, alongside a real one", () => {
    const parsed = profileV1PutBodySchema.parse({
      ...BASE,
      tools: { permissions: { household: { look_up: null, add_to_list: "ask" } } },
    });
    expect(parsed.tools.permissions?.household?.look_up).toBeNull();
    expect(parsed.tools.permissions?.household?.add_to_list).toBe("ask");
  });

  it("still rejects a value that is neither a real permission nor null", () => {
    expect(() =>
      profileV1PutBodySchema.parse({ ...BASE, tools: { permissions: { household: { look_up: "auto" } } } }),
    ).toThrow();
  });

  it("still migrates a legacy tools.enabled body the same way the stored schema does", () => {
    const parsed = profileV1PutBodySchema.parse({
      ...BASE,
      tools: { enabled: { home_assistant: [] }, toolsets: ["memory"] },
    });
    expect(parsed.tools.permissions?.home_assistant).toEqual({});
  });

  it("validates every other field identically to the stored schema", () => {
    expect(() =>
      profileV1PutBodySchema.parse({ ...BASE, model: { provider: "not-a-real-provider", id: "x" }, tools: {} }),
    ).toThrow();
  });
});
