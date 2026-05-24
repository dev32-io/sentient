import type { McpPolicy, PolicyRule } from "@sentient/config";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "security", "policy-engine"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyContext {
  tool: string;
  userId: string | null;
  role: "adult" | "child" | "guest" | "user";
  sessionChannel: "voice" | "text";
  args: Record<string, unknown>;
}

export interface PolicyDecision {
  action: "allow" | "deny" | "confirm";
  reason?: string;
  rule?: string;
}

export interface PolicyEngine {
  evaluate(ctx: PolicyContext): PolicyDecision;
}

// ---------------------------------------------------------------------------
// Condition evaluator — deterministic, no dynamic eval
// ---------------------------------------------------------------------------

/** Parse a simple predicate like `tool == "x"` or `role != "child"`. */
function parsePredicate(pred: string): { field: string; op: "==" | "!="; value: string } | null {
  const match = pred.trim().match(/^([\w.]+)\s*(==|!=)\s*"([^"]*)"$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { field: match[1], op: match[2] as "==" | "!=", value: match[3] };
}

/** Resolve a field name to a value from the policy context. */
function resolveField(field: string, ctx: PolicyContext): string | null {
  if (field === "tool") return ctx.tool;
  if (field === "userId") return ctx.userId;
  if (field === "role") return ctx.role;
  if (field === "session.channel") return ctx.sessionChannel;
  // Args access: args.xxx
  if (field.startsWith("args.")) {
    const key = field.slice(5);
    const val = ctx.args[key];
    return typeof val === "string" ? val : null;
  }
  return null;
}

/** Evaluate a single predicate against the context. */
function evalPredicate(pred: string, ctx: PolicyContext): boolean {
  const parsed = parsePredicate(pred);
  if (!parsed) {
    log.debug("policy-engine.unparseable-predicate", { pred });
    return false;
  }
  const actual = resolveField(parsed.field, ctx);
  if (actual === null) return false;
  return parsed.op === "==" ? actual === parsed.value : actual !== parsed.value;
}

/** Evaluate a condition string (supports ` AND ` / ` OR ` combinators). */
export function evaluateCondition(cond: string, ctx: PolicyContext): boolean {
  // OR has lower precedence than AND
  const orParts = cond.split(" OR ");
  for (const orPart of orParts) {
    const andParts = orPart.split(" AND ");
    const allTrue = andParts.every((p) => evalPredicate(p.trim(), ctx));
    if (allTrue) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Policy engine factory
// ---------------------------------------------------------------------------

const ALLOW: PolicyDecision = { action: "allow" };

export function createPolicyEngine(policy: McpPolicy): PolicyEngine {
  const rules: readonly PolicyRule[] = policy.rules;
  return {
    evaluate(ctx: PolicyContext): PolicyDecision {
      for (const rule of rules) {
        if (rule.tool !== "*" && rule.tool !== ctx.tool) continue;
        if (!evaluateCondition(rule.condition, ctx)) continue;
        log.debug("policy-engine.matched", { rule: rule.name, action: rule.action, tool: ctx.tool });
        return { action: rule.action, reason: rule.reason, rule: rule.name };
      }
      return ALLOW;
    },
  };
}
