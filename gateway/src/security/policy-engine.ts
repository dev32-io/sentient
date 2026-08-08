import type { McpPolicy, PolicyRule } from "@sentient/config";
import type { UserRole } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "security", "policy-engine"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyContext {
  tool: string;
  userId: string | null;
  /** Every real caller's role is a `UserRole` — the value baked into the
   *  caller's capability. `"user"` is not one: it is the pseudo-role the
   *  gateway's OWN hosted-tool socket evaluates under
   *  (`create-mcp-host.ts`'s `contextFor`), where there is no household member
   *  on the other end to have a role. */
  role: UserRole | "user";
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
// Unmatched-tool classification (design §2.2)
// ---------------------------------------------------------------------------
//
// THE CLASSIFICATION RULE, stated once: a tool is read/low-risk ONLY when the
// policy file says so with an explicit `allow` rule. Absence of a rule is not
// evidence that a tool is harmless — a tool nobody tiered is classified
// side-effecting and mediated. The engine used to return `allow` here, which
// meant every write surface the operator file forgot (`ha_bulk_control` and
// every uncurated MCP server's tools) dispatched with no mediation at all.
//
// `confirm`, not `deny`, because the deny tier in §2.2 is reserved for
// argument-value violations — a hard deny on everything unnamed would refuse
// work outright with no way for the human to say yes. `confirm` routes the
// call to the L3 permission prompt, which is itself fail-closed: a timeout,
// a closed socket, or an aborted turn all resolve to deny (tool-broker.ts).
//
// The prompt-free read tier is therefore an ALLOWLIST, declared per tool in
// `gateway/mcp-policy.yaml` — that file, not this constant, is where the
// operator tunes which queries run without friction.

const UNMATCHED_RULE_NAME = "default:unclassified-tool";

const UNMATCHED: PolicyDecision = {
  action: "confirm",
  reason: "No policy rule classifies this tool, so it is treated as side-effecting",
  rule: UNMATCHED_RULE_NAME,
};

// ---------------------------------------------------------------------------
// Policy engine factory
// ---------------------------------------------------------------------------

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
      log.warn("policy-engine.unmatched", {
        tool: ctx.tool,
        action: UNMATCHED.action,
        reason: "no rule tiers this tool — classified side-effecting, fail-closed per design §2.2",
      });
      return UNMATCHED;
    },
  };
}
