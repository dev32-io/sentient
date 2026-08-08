import { describe, expect, it } from "bun:test";
import type { ToolPermissionMap } from "@sentient/config";
import type { ProfileV1 } from "./profile-types.js";
import { applyProfileUpdate } from "./profile-update.js";

function profile(permissions: ToolPermissionMap | undefined, toolsets?: string[]): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "alice",
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "voice-abc" },
    audio: { ttsEnabled: true, channel: "voice" },
    persona: { template: "default", overrides: "" },
    tools: { ...(permissions === undefined ? {} : { permissions }), ...(toolsets === undefined ? {} : { toolsets }) },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

const TEMPLATE: ToolPermissionMap = {
  household: { look_up: "allow", add_to_list: "ask" },
  gateway: { identify_user: "allow" },
};

describe("a PUT replaces only the permission keys it names", () => {
  const stored = profile({
    household: { look_up: "allow", add_to_list: "ask" },
    workshop: { solder: "deny" },
  });

  it("overwrites a named tool and keeps its siblings under the same server", () => {
    const out = applyProfileUpdate(profile({ household: { look_up: "off" } }), {
      stored,
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.permissions).toEqual({
      household: { look_up: "off", add_to_list: "ask" },
      workshop: { solder: "deny" },
    });
  });

  it("keeps a server the body never mentions", () => {
    const out = applyProfileUpdate(profile({ household: { look_up: "off" } }), {
      stored,
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.permissions?.workshop).toEqual({ solder: "deny" });
  });

  it("changes nothing when the body carries no table at all", () => {
    const out = applyProfileUpdate(profile(undefined), { stored, permissionDefaults: TEMPLATE });
    expect(out.tools.permissions).toEqual(stored.tools.permissions ?? {});
  });

  it("changes nothing when the body carries an EMPTY table — that is 'no opinion'", () => {
    const out = applyProfileUpdate(profile({}), { stored, permissionDefaults: TEMPLATE });
    expect(out.tools.permissions).toEqual(stored.tools.permissions ?? {});
  });

  it("adds a server the stored table did not have", () => {
    const out = applyProfileUpdate(profile({ garage: { open_door: "ask" } }), {
      stored,
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.permissions?.garage).toEqual({ open_door: "ask" });
    expect(out.tools.permissions?.workshop).toEqual({ solder: "deny" });
  });
});

// ---------------------------------------------------------------------------
// ORDERING. Seed FIRST, then apply the delta on top.
//
// The other order — merge, then seed only if the result is still absent — looks
// equivalent and is not: a partial body over a never-tabled profile produces a
// one-entry table, which is no longer absent, so the template never lands and
// every OTHER tool is permanently unset. Under the delta semantics a partial
// body is the EXPECTED shape, so that is the common path, not an edge.
// ---------------------------------------------------------------------------
describe("a never-tabled profile is seeded before the body's delta is applied", () => {
  it("seeds the whole template and puts the body's value on top of it", () => {
    const out = applyProfileUpdate(profile({ household: { look_up: "off" } }), {
      stored: profile(undefined),
      permissionDefaults: TEMPLATE,
    });

    expect(out.tools.permissions).toEqual({
      // the body's one opinion…
      household: { look_up: "off", add_to_list: "ask" },
      // …and every other tool the template carries, which a merge-then-seed
      // ordering would have dropped on the floor.
      gateway: { identify_user: "allow" },
    });
  });

  it("seeds the template verbatim when the body names nothing", () => {
    const out = applyProfileUpdate(profile(undefined), {
      stored: profile(undefined),
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.permissions).toEqual(TEMPLATE);
  });

  it("seeds when there is no stored profile at all", () => {
    const out = applyProfileUpdate(profile({ household: { look_up: "off" } }), {
      stored: undefined,
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.permissions).toEqual({
      household: { look_up: "off", add_to_list: "ask" },
      gateway: { identify_user: "allow" },
    });
  });

  it("does NOT re-seed a stored table that exists but names no server", () => {
    // `{}` is a table somebody wrote that names no server — every server off.
    // Seeding over it would turn the whole household back on.
    const out = applyProfileUpdate(profile(undefined), { stored: profile({}), permissionDefaults: TEMPLATE });
    expect(out.tools.permissions).toEqual({});
  });

  it("saves the body unchanged when no template is available", () => {
    // The account's role could not be read. Seeding is a repair, not a grant:
    // skipping it leaves the profile exactly as complete as it already was.
    const out = applyProfileUpdate(profile(undefined), { stored: profile(undefined), permissionDefaults: undefined });
    expect(out.tools.permissions).toBeUndefined();
  });
});

describe("everything outside tools.permissions is replaced outright", () => {
  it("takes toolsets from the body verbatim, including an explicitly empty list", () => {
    // An empty toolsets list is legal and meaningful — "no built-ins,
    // MCP-only". Refilling it here would silently hand four Hermes toolsets
    // back to somebody who turned them all off.
    const out = applyProfileUpdate(profile(undefined, []), {
      stored: profile(undefined, ["memory", "todo"]),
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.toolsets).toEqual([]);
  });

  it("takes the body's voice and model, never the stored ones", () => {
    const incoming = profile(undefined);
    const out = applyProfileUpdate(
      { ...incoming, voice: { provider: "local-tts", id: "new-voice" } },
      { stored: { ...incoming, voice: { provider: "local-tts", id: "old-voice" } }, permissionDefaults: TEMPLATE },
    );
    expect(out.voice.id).toBe("new-voice");
  });
});

// A permissions table is keyed by names a client chooses. `merged[server] = …`
// on a plain object would let `__proto__` reach the prototype setter instead of
// creating an own property, which silently drops the entry.
describe("a server key from the body cannot reach the prototype", () => {
  it("keeps a __proto__ server as an own key and leaves Object.prototype alone", () => {
    const out = applyProfileUpdate(profile(JSON.parse('{"__proto__":{"evil":"allow"}}')), {
      stored: profile({ household: { look_up: "allow" } }),
      permissionDefaults: TEMPLATE,
    });

    expect(Object.hasOwn(out.tools.permissions ?? {}, "__proto__")).toBe(true);
    expect(out.tools.permissions?.household).toEqual({ look_up: "allow" });
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });
});
