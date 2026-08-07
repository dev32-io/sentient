import { describe, expect, it } from "bun:test";
import type { Result } from "@sentient/protocol";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import { createToolPermissionsReader } from "./user-tool-permissions.js";

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY: a settings file the gateway cannot read must never grant
// more than the last one it could.
//
// The failure this suite exists for: somebody sets `ha_get_camera_image` to
// `deny`, `profile.json` later becomes unparseable, and the next session
// advertises the tool AND dispatches it with no prompt, because mcp-policy.yaml
// allow-tiers it. One WARN would have been the only trace.
//
// `not-found` is the one error class that legitimately means "nothing was ever
// set" — there is no profile, so there is no table, so inheriting the operator
// policy is not a widening. Every other class means "a table may exist and I
// cannot see it".
// ---------------------------------------------------------------------------

function profileWith(permissions: ProfileV1["tools"]["permissions"]): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "u_aaaaaaaa",
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" },
    persona: { template: "default", overrides: "" },
    tools: { permissions, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

/** Answers `get` from a queue, so one reader can see a success followed by a
 *  failure — which is the sequence the last-known-table rule is about. */
function storeReturning(...results: Array<Result<ProfileV1, ProfileStoreError>>): ProfileStore {
  let i = 0;
  const refuse = () => {
    throw new Error("not used by the permissions reader");
  };
  return {
    get: async () => results[Math.min(i++, results.length - 1)] as Result<ProfileV1, ProfileStoreError>,
    save: refuse,
    remove: refuse,
  };
}

const reader = (store: ProfileStore) => createToolPermissionsReader({ profileStore: store, userId: "u_aaaaaaaa" });

describe("tool-permissions reader — what an unreadable profile reports", () => {
  it("reports UNSET for not-found: there is no profile, so nothing was ever set", async () => {
    const read = reader(storeReturning({ ok: false, error: "not-found" }));

    expect(await read()).toBeUndefined();
  });

  it("SECURITY: reports a deny-every-server table for corrupt-file, never unset", async () => {
    const read = reader(storeReturning({ ok: false, error: "corrupt-file" }));

    // `{}` — a table naming no server. NOT `undefined`, which the broker reads
    // as "inherit mcp-policy.yaml" and would re-advertise a denied tool.
    expect(await read()).toEqual({});
    expect(await read()).not.toBeUndefined();
  });

  it("SECURITY: reports a deny-every-server table for io-error, never unset", async () => {
    const read = reader(storeReturning({ ok: false, error: "io-error" }));

    expect(await read()).toEqual({});
  });

  it("SECURITY: a profile that goes unreadable keeps the last table it successfully reported", async () => {
    const table = { home_assistant: { ha_get_camera_image: "deny" as const } };
    const read = reader(storeReturning({ ok: true, value: profileWith(table) }, { ok: false, error: "corrupt-file" }));

    expect(await read()).toEqual(table);
    // A profile cannot un-say what it already said.
    expect(await read()).toEqual(table);
  });

  it("reports UNSET when the field itself is absent from a perfectly readable profile", async () => {
    const read = reader(storeReturning({ ok: true, value: profileWith(undefined) }));

    expect(await read()).toBeUndefined();
  });

  it("clears a stale table when a later successful read says the field is unset", async () => {
    const read = reader(
      storeReturning({ ok: true, value: profileWith({ searxng: {} }) }, { ok: true, value: profileWith(undefined) }),
    );

    expect(await read()).toEqual({ searxng: {} });
    // A SUCCESSFUL read is the current answer, whatever it says — only failures
    // fall back to the anchor.
    expect(await read()).toBeUndefined();
  });
});
