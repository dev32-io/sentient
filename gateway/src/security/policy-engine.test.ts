import type { McpPolicy } from "@sentient/config";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, evaluateCondition } from "./policy-engine.js";
import type { PolicyContext } from "./policy-engine.js";

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

  it("allows identify_user for adult on voice", () => {
    const decision = engine.evaluate({
      tool: "identify_user",
      userId: "alice",
      role: "adult",
      sessionChannel: "voice",
      args: {},
    });
    expect(decision.action).toBe("allow");
    expect(decision.rule).toBeUndefined();
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

  it("defaults to allow when no rule matches", () => {
    const decision = engine.evaluate({
      tool: "resume_audio",
      userId: "alice",
      role: "adult",
      sessionChannel: "text",
      args: {},
    });
    expect(decision.action).toBe("allow");
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
