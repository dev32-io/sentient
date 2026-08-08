import { describe, expect, it } from "bun:test";
import type { ToolPermissionMap, ToolPermissionPatchMap } from "@sentient/config";
import { resolveToolPermission } from "../tools/resolve-tool-permission.js";
import type { ProfileV1, ProfileV1PutBody } from "./profile-types.js";
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

/** Builds an INCOMING PUT body — unlike `profile()` above (which builds a
 *  STORED `ProfileV1`, whose permission leaves are never `null`), this one's
 *  `permissions` may name a key with `null` to CLEAR it. Separate helper
 *  rather than widening `profile()` itself: every `stored:` fixture in this
 *  file needs the STORED type, and widening `profile()`'s return type would
 *  stop satisfying it. */
function putBody(permissions: ToolPermissionPatchMap | undefined): ProfileV1PutBody {
  return {
    schemaVersion: 1,
    userId: "alice",
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "voice-abc" },
    audio: { ttsEnabled: true, channel: "voice" },
    persona: { template: "default", overrides: "" },
    tools: { ...(permissions === undefined ? {} : { permissions }) },
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

  // Same hazard one level down: a TOOL name is exactly as client-chosen as a
  // server name. `mergeServer` (profile-update.ts) uses two arrays plus one
  // closing `Object.fromEntries` instead of `merged[tool] = …` for this reason.
  it("keeps a __proto__ tool as an own key within a server and leaves Object.prototype alone", () => {
    const out = applyProfileUpdate(profile(JSON.parse('{"household":{"__proto__":"allow"}}')), {
      stored: profile({ household: { look_up: "allow" } }),
      permissionDefaults: TEMPLATE,
    });

    expect(Object.hasOwn(out.tools.permissions?.household ?? {}, "__proto__")).toBe(true);
    expect(out.tools.permissions?.household?.look_up).toBe("allow");
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLEARING. A `null` leaf removes that key instead of writing it, which is
// what lets a client honestly say "I have no opinion here anymore" — the
// state a person needs to be able to return to now that an absent key means
// "the role template decides" rather than `off` (see `applyProfileUpdate`'s
// doc comment for why this retires the rev-1 "never delete a key" rule's
// RATIONALE without contradicting its text: nothing here deletes a key from
// the BODY or the STORED table wholesale — `null` only ever targets one
// named key, exactly like a real permission value does).
// ---------------------------------------------------------------------------
describe("a null value clears that key instead of writing it", () => {
  it("removes just the cleared tool, keeping its siblings under the same server", () => {
    const stored = profile({ household: { look_up: "allow", add_to_list: "ask" } });
    const out = applyProfileUpdate(putBody({ household: { look_up: null } }), {
      stored,
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.permissions?.household).toEqual({ add_to_list: "ask" });
  });

  it("leaves the server key present with an empty map when its last key is cleared — never removes the server key", () => {
    const stored = profile({ household: { look_up: "off" } });
    const out = applyProfileUpdate(putBody({ household: { look_up: null } }), {
      stored,
      permissionDefaults: TEMPLATE,
    });
    // An absent server key is a stored "off" forever (the absent-server
    // rule); an empty map is "present, no opinions" and falls through to the
    // role template. Collapsing the two would turn "restore my defaults"
    // into "hide the whole server" — the opposite of what a clear means.
    expect(Object.hasOwn(out.tools.permissions ?? {}, "household")).toBe(true);
    expect(out.tools.permissions?.household).toEqual({});
  });

  it("clearing a wildcard alongside a per-tool override keeps the override", () => {
    const stored = profile({ household: { "*": "off", unlock_door: "ask" } });
    const out = applyProfileUpdate(putBody({ household: { "*": null } }), {
      stored,
      permissionDefaults: TEMPLATE,
    });
    expect(out.tools.permissions?.household).toEqual({ unlock_door: "ask" });
  });

  it("a cleared key resolves through the floor to the role template's answer, not just an empty table shape", () => {
    const stored = profile({ household: { look_up: "off" } });
    const out = applyProfileUpdate(putBody({ household: { look_up: null } }), {
      stored,
      permissionDefaults: TEMPLATE,
    });
    const resolved = resolveToolPermission({
      toolName: "look_up",
      tier: "read",
      serverName: "household",
      storedPermissions: out.tools.permissions,
      roleTemplate: TEMPLATE,
    });
    expect(resolved).toEqual({ permission: "allow", source: "role-template" });
  });
});

// ---------------------------------------------------------------------------
// THE REGRESSION THIS FIX EXISTS FOR. A server master control's "off" writes
// the wildcard explicitly (`{"*": "off"}`); its "on" must CLEAR the wildcard
// (`{"*": null}`), never write a concrete value such as `"allow"` — writing
// ANY concrete value forecloses the role template for every tool under that
// server with no per-tool override, `confirm`-tier ones included. Exercised
// against the REAL resolver (`resolve-tool-permission.ts`), not just the
// merged table's shape, because the shape alone cannot tell "off then
// allow-by-accident" apart from "off then genuinely back to the template".
// ---------------------------------------------------------------------------
describe("a server's master control can restore role-template defaults without ratcheting privilege", () => {
  // Stands in for a real `confirm`-tier tool (a door lock): the role
  // template's own answer for it is `ask`, never `allow` — the entire point
  // of the confirm tier is that the model must not act on it unprompted.
  const TEMPLATE_WITH_LOCK: ToolPermissionMap = {
    household: { look_up: "allow", unlock_door: "ask" },
  };

  it("off then on (clear) resolves a confirm-tier tool back to 'ask', never 'allow'", () => {
    // `household` HAS a stored table (an older tool, `look_up`, was already
    // named — seeding is not the point of this test) but has never named
    // `unlock_door` at all, the same way a tool the operator adds to the
    // catalog after this account was seeded would be absent: this is what
    // "never touched" means for one specific tool once a floor exists — a
    // NAMED entry (from seeding or an earlier edit) always outranks the
    // wildcard, so it is the UNNAMED case the master control's write must
    // stay safe for.
    const seeded = profile({ household: { look_up: "allow" } });

    // Master "off": the wildcard hides every un-overridden tool on the server.
    const off = applyProfileUpdate(putBody({ household: { "*": "off" } }), {
      stored: seeded,
      permissionDefaults: TEMPLATE_WITH_LOCK,
    });
    expect(
      resolveToolPermission({
        toolName: "unlock_door",
        tier: "confirm",
        serverName: "household",
        storedPermissions: off.tools.permissions,
        roleTemplate: TEMPLATE_WITH_LOCK,
      }).permission,
    ).toBe("off");

    // Master "on": CLEARS the wildcard instead of writing "allow". A
    // regression that wrote a concrete value here (this fix's bug) would
    // make the assertion below observe "allow" instead of "ask".
    const backOn = applyProfileUpdate(putBody({ household: { "*": null } }), {
      stored: off,
      permissionDefaults: TEMPLATE_WITH_LOCK,
    });
    const resolved = resolveToolPermission({
      toolName: "unlock_door",
      tier: "confirm",
      serverName: "household",
      storedPermissions: backOn.tools.permissions,
      roleTemplate: TEMPLATE_WITH_LOCK,
    });
    expect(resolved.permission).toBe("ask");
    expect(resolved.permission).not.toBe("allow");

    // The un-overridden read-tier tool is unaffected either way — this test
    // is about the confirm-tier tool specifically, not "nothing resolves".
    expect(
      resolveToolPermission({
        toolName: "look_up",
        tier: "read",
        serverName: "household",
        storedPermissions: backOn.tools.permissions,
        roleTemplate: TEMPLATE_WITH_LOCK,
      }).permission,
    ).toBe("allow");
  });
});
