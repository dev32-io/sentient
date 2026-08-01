import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type McpPolicy, loadConfig, mcpCatalogSchema } from "@sentient/config";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPolicyEngine, evaluateCondition } from "./policy-engine.js";
import type { PolicyContext } from "./policy-engine.js";
import { loadMcpPolicy } from "./policy-loader.js";

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  const ctx: PolicyContext = {
    tool: "identify_user",
    userId: "alice",
    role: "adult",
    sessionChannel: "voice",
    args: {},
  };

  it("matches equality predicate", () => {
    expect(evaluateCondition('tool == "identify_user"', ctx)).toBe(true);
  });

  it("rejects non-matching equality", () => {
    expect(evaluateCondition('tool == "pause_audio"', ctx)).toBe(false);
  });

  it("matches inequality predicate", () => {
    expect(evaluateCondition('role != "child"', ctx)).toBe(true);
  });

  it("rejects non-matching inequality", () => {
    expect(evaluateCondition('role != "adult"', ctx)).toBe(false);
  });

  it("matches session.channel equality", () => {
    expect(evaluateCondition('session.channel == "voice"', ctx)).toBe(true);
  });

  it("matches userId equality", () => {
    expect(evaluateCondition('userId == "alice"', ctx)).toBe(true);
  });

  it("evaluates AND combinator — all true", () => {
    expect(evaluateCondition('tool == "identify_user" AND role == "adult"', ctx)).toBe(true);
  });

  it("evaluates AND combinator — one false", () => {
    expect(evaluateCondition('tool == "identify_user" AND role == "child"', ctx)).toBe(false);
  });

  it("evaluates OR combinator — one true", () => {
    expect(evaluateCondition('role == "child" OR role == "adult"', ctx)).toBe(true);
  });

  it("evaluates OR combinator — all false", () => {
    expect(evaluateCondition('role == "child" OR role == "guest"', ctx)).toBe(false);
  });

  it("returns false for unparseable predicates", () => {
    expect(evaluateCondition("gibberish", ctx)).toBe(false);
  });

  it("returns false for unknown field names", () => {
    expect(evaluateCondition('unknown_field == "x"', ctx)).toBe(false);
  });

  it("accesses args fields", () => {
    const ctxWithArgs: PolicyContext = { ...ctx, args: { name: "bob" } };
    expect(evaluateCondition('args.name == "bob"', ctxWithArgs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PolicyEngine
// ---------------------------------------------------------------------------

describe("PolicyEngine", () => {
  const policy: McpPolicy = {
    rules: [
      {
        name: "no_identify_user_outside_voice",
        tool: "identify_user",
        condition: 'session.channel != "voice"',
        action: "deny",
        reason: "Identity changes via voice phrase only",
      },
      {
        name: "no_guest_identify",
        tool: "identify_user",
        condition: 'role == "guest"',
        action: "deny",
        reason: "Guest sessions cannot rebind",
      },
      {
        name: "child_cannot_pause_audio",
        tool: "pause_audio",
        condition: 'role == "child"',
        action: "deny",
        reason: "Audio control restricted for child role",
      },
      {
        name: "allow_ha_get_state",
        tool: "ha_get_state",
        condition: 'tool == "ha_get_state"',
        action: "allow",
        reason: "Read-only Home Assistant query",
      },
    ],
  };

  const engine = createPolicyEngine(policy);

  it("denies identify_user for guest role", () => {
    const decision = engine.evaluate({
      tool: "identify_user",
      userId: null,
      role: "guest",
      sessionChannel: "voice",
      args: {},
    });
    expect(decision.action).toBe("deny");
    expect(decision.rule).toBe("no_guest_identify");
  });

  it("denies identify_user outside voice channel", () => {
    const decision = engine.evaluate({
      tool: "identify_user",
      userId: "alice",
      role: "adult",
      sessionChannel: "text",
      args: {},
    });
    expect(decision.action).toBe("deny");
    expect(decision.rule).toBe("no_identify_user_outside_voice");
  });

  it("allows a tool an explicit allow rule puts in the read tier", () => {
    const decision = engine.evaluate({
      tool: "ha_get_state",
      userId: "alice",
      role: "adult",
      sessionChannel: "voice",
      args: {},
    });
    expect(decision.action).toBe("allow");
    expect(decision.rule).toBe("allow_ha_get_state");
  });

  it("requires confirmation when only deny rules name the tool and none match", () => {
    // identify_user has two deny rules; neither matches an adult on voice. Not
    // denied is NOT the same as allowed — it falls to the side-effecting default.
    const decision = engine.evaluate({
      tool: "identify_user",
      userId: "alice",
      role: "adult",
      sessionChannel: "voice",
      args: {},
    });
    expect(decision.action).toBe("confirm");
  });

  it("denies pause_audio for child role", () => {
    const decision = engine.evaluate({
      tool: "pause_audio",
      userId: "kid",
      role: "child",
      sessionChannel: "voice",
      args: {},
    });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("Audio control restricted for child role");
  });

  // SECURITY BOUNDARY (spec §2.2 "fail-closed for side-effecting tools"). The
  // engine used to return `allow` here, so every write tool the policy file
  // forgot — ha_bulk_control among them — dispatched with no mediation at all.
  it("classifies a tool no rule names as side-effecting and requires confirmation", () => {
    const decision = engine.evaluate({
      tool: "ha_bulk_control",
      userId: "alice",
      role: "adult",
      sessionChannel: "text",
      args: {},
    });
    expect(decision.action).toBe("confirm");
    expect(decision.reason).toBeTruthy();
  });

  it("stays fail-closed when the policy file is empty", () => {
    const decision = createPolicyEngine({ rules: [] }).evaluate({
      tool: "anything_at_all",
      userId: "alice",
      role: "adult",
      sessionChannel: "text",
      args: {},
    });
    expect(decision.action).toBe("confirm");
  });

  it("first matching rule wins — guest on text hits guest rule, not channel rule", () => {
    const decision = engine.evaluate({
      tool: "identify_user",
      userId: null,
      role: "guest",
      sessionChannel: "text",
      args: {},
    });
    // "no_identify_user_outside_voice" matches first (tool=identify_user, channel=text)
    expect(decision.action).toBe("deny");
    expect(decision.rule).toBe("no_identify_user_outside_voice");
  });
});

// ---------------------------------------------------------------------------
// Shipped policy (gateway/mcp-policy.yaml)
//
// SECURITY BOUNDARY. The engine's fail-closed default is only half the fix:
// the operator file is where the read tier earns its prompt-free path, so a
// careless edit there re-opens the same hole from the other side. These cases
// pin the tiering of the tools `gateway/config.yaml#mcp_catalog` actually
// exposes — write surfaces mediated, queries not.
// ---------------------------------------------------------------------------

describe("shipped mcp-policy.yaml", () => {
  const engine = createPolicyEngine(loadMcpPolicy());

  function decide(tool: string): string {
    return engine.evaluate({ tool, userId: "u_a1b2c3d4", role: "adult", sessionChannel: "voice", args: {} }).action;
  }

  it.each([
    "ha_get_overview",
    "ha_get_state",
    "ha_search_entities",
    "ha_get_todo",
    "search_web",
    "fetch",
    "ma_search",
    "ma_list_players",
    "ma_playback",
  ])("leaves the read/low-risk tool %s prompt-free", (tool) => {
    expect(decide(tool)).toBe("allow");
  });

  it.each([
    "ha_call_service",
    "ha_bulk_control",
    "ha_set_todo_item",
    "ha_remove_todo_item",
    "ha_config_set_calendar_event",
    "ha_config_remove_calendar_event",
    "update_user_settings",
    "ma_queue",
    "ma_queue_item",
    "ma_group",
  ])("mediates the write/side-effecting tool %s", (tool) => {
    expect(decide(tool)).toBe("confirm");
  });

  it("mediates a tool the file does not tier at all", () => {
    expect(decide("some_new_mcp_write_tool")).toBe("confirm");
  });

  // The file used to tier this `allow`, deferring to the DelegationGuard — which
  // classifies rather than prompts, so `low → allow` on every ordinary prompt
  // and no human ever saw a delegation before it ran. Measured 2026-07-31: a
  // prompt asking to write ~/.ssh/authorized_keys classified `low`. The guard is
  // an injection scanner, not a risk classifier, and the delegated worker holds
  // its own tool surface (its builtin write_file included) that the gateway's
  // proxy tier never sees. Until a real tiered classifier lands, delegation asks.
  it("mediates delegateTask, the one tool that hands a whole prompt to another agent", () => {
    expect(decide("delegateTask")).toBe("confirm");
  });
});

// ---------------------------------------------------------------------------
// Catalog ↔ policy coverage (gateway/config.yaml#mcp_catalog vs mcp-policy.yaml)
//
// SECURITY BOUNDARY, second half. Failing closed MEDIATES an untiered tool; it
// does not TIER it. Two ways that degrades into a prompt on every call:
//
//   1. a catalog entry with no `tools.include` puts an unknown, upstream-owned
//      tool surface into the vocabulary — nobody can tier what nobody can
//      enumerate, and an upstream bump silently adds more of it;
//   2. an enumerated tool no rule names lands on the fail-closed default, so
//      even its read path prompts.
//
// Both halves are pinned here, so adding an MCP to the catalog without tiering
// its tools fails the suite instead of shipping friction (or, before the
// fail-closed default, silent dispatch).
// ---------------------------------------------------------------------------

describe("mcp_catalog ↔ mcp-policy.yaml coverage", () => {
  const policy = loadMcpPolicy();
  const engine = createPolicyEngine(policy);
  const ruleNames = new Set(policy.rules.map((rule) => rule.name));
  const catalog = loadConfig(
    readFileSync(join(import.meta.dir, "../../config.yaml"), "utf-8"),
    z.object({ mcp_catalog: mcpCatalogSchema }),
  ).mcp_catalog;

  const curated = Object.entries(catalog).flatMap(([server, entry]) =>
    (entry.tools?.include ?? []).map((tool) => ({ server, tool })),
  );

  it("curates every catalog entry's tool surface with tools.include", () => {
    const uncurated = Object.entries(catalog)
      .filter(([, entry]) => entry.tools?.include === undefined)
      .map(([server]) => server);
    expect(uncurated).toEqual([]);
  });

  // Evaluated as an adult on voice: the role/channel deny rules do not fire, so
  // anything that still reaches the default is genuinely untiered rather than
  // merely allowed for this caller.
  it("tiers every catalog tool with a named rule instead of the fail-closed default", () => {
    const untiered = curated
      .filter(({ tool }) => {
        const decision = engine.evaluate({
          tool,
          userId: "u_a1b2c3d4",
          role: "adult",
          sessionChannel: "voice",
          args: {},
        });
        return !ruleNames.has(decision.rule ?? "");
      })
      .map(({ server, tool }) => `${server}/${tool}`);
    expect(untiered).toEqual([]);
  });
});
