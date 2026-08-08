// Which tools a DELEGATED agent (Hermes, today) is allowed to hold.
//
// TWO TIERS, DIFFERENT IN KIND (owner, 2026-07-30). The user's own MCP setup —
// whatever they or Hermes configure, by hand or through an LLM — is never ours
// to touch. On top of it the gateway PROVIDES a second tier through its own
// per-user MCP socket: the tools it hosts in-process, plus a proxy over the
// operator's `mcp_catalog`. This module decides what may enter that second
// tier, and nothing else.
//
// DERIVED, NEVER LISTED. The set comes from `gateway/mcp-policy.yaml` through
// the same `PolicyEngine` the gateway's own loop uses. A second hardcoded
// spelling of "which tools are safe" is a thing that must agree with the
// policy file and eventually will not — the exact defect class this codebase
// has already paid for twice. A tool that matches NO rule resolves to
// `confirm` (policy-engine's `UNMATCHED`) and is therefore dropped: inheriting
// the fail-closed default is the point.
//
// WHY `allow` ONLY, AND WHY THE TWO PATHS DIFFER. The gateway's own hosted
// tools execute inside `mcp-host/mcp-server.ts`, whose `confirm` branch
// auto-approves — a delegated call has no human attached to prompt — so for
// those the filter IS the boundary. A PROXIED catalog tool executes through
// `tools/tool-broker.ts`, whose `confirm` branch fails closed, so for those the
// filter decides what the socket ADVERTISES and the broker is the boundary.
// Either way the advertised surface must match the surface that would actually
// execute, which is why the caller passes the context ITS execution path
// evaluates under instead of both inheriting one constant.
//
// The proper answer — a permission surface for delegated tools tuned
// independently of Sentient's own tool settings — is recorded in
// `docs/native-todo.md` § 1 as its own later design.

import type { UserRole } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { PolicyContext, PolicyEngine } from "../security/policy-engine.js";

const log = getLog(["sentient", "external-tools", "delegated-tier"]);

/** The role/channel half of a `PolicyContext`. `userId` is deliberately not
 *  part of it: tiering is a property of the tool, not of who is asking, and no
 *  shipped rule reads `userId`. */
export interface DelegatedPolicyContext {
  readonly role: PolicyContext["role"];
  readonly sessionChannel: PolicyContext["sessionChannel"];
}

/**
 * Context the gateway's OWN hosted tools are evaluated under.
 *
 * MUST match `mcp-host/unix-socket-listener.ts`'s `contextFor`, or the surface
 * the gateway advertises to the delegated agent and the surface it will
 * actually execute disagree — a tool listed but denied at call time, or worse
 * the reverse.
 */
export const HOSTED_TOOL_CONTEXT: DelegatedPolicyContext = { role: "user", sessionChannel: "voice" };

/**
 * The role the PROXIED tier is ADVERTISED under — and only advertised.
 *
 * There used to be a `DELEGATED_PRINCIPAL_ROLE` here, hardcoded `"adult"`, and
 * `mcp-host/delegated-broker.ts` minted every delegated principal with it. That
 * is gone: a delegated agent acts FOR its user, so the broker now looks the
 * delegator's REAL role up from the user store and bakes THAT into its
 * capability (plan 2026-08-07-tool-permissions task 2b, step 6). Leaving the
 * constant would have meant the delegated path silently stopped tracking its
 * delegator the moment roles became real — a child's delegation running with an
 * adult's authority.
 *
 * What survives is this, and it is a different question. The gateway's per-user
 * MCP socket shares ONE advertised proxied surface across every user (see
 * `mcp-host/proxied-tool-surface.ts` — it is built once and refreshed on
 * `tools/list`, not built per connection), so the advertised set cannot be
 * per-role. It is pinned to the widest ORDINARY household role, deliberately:
 *
 *   * never `admin` — an operator-tier tool must not appear on a surface every
 *     delegated agent shares; and
 *   * advertising can only over-LIST, never over-GRANT. Execution goes through
 *     `proxied-catalog-tool.ts` → the delegator's own `ToolBroker`, whose
 *     capability carries the delegator's real role, so a child's delegation
 *     that calls a listed-but-forbidden tool gets a legible deny.
 */
export const PROXIED_ADVERTISEMENT_ROLE: UserRole = "adult";

/**
 * Context a PROXIED catalog tool is ADVERTISED under.
 *
 * `sessionChannel` must match `tool-broker.ts`'s `resolveDecision`, which
 * hardcodes `"text"` — same reason as `HOSTED_TOOL_CONTEXT`: what is listed
 * must be evaluated the way it will execute.
 */
export const PROXIED_TOOL_CONTEXT: DelegatedPolicyContext = {
  role: PROXIED_ADVERTISEMENT_ROLE,
  sessionChannel: "text",
};

/**
 * Narrow `toolNames` to the tools the shipped policy tiers `allow` for a
 * delegated caller under `context`. Order is preserved so callers get a stable,
 * loggable set.
 */
export function selectDelegatedAllowTier(
  policy: PolicyEngine,
  toolNames: readonly string[],
  context: DelegatedPolicyContext = HOSTED_TOOL_CONTEXT,
): string[] {
  const allowed: string[] = [];
  const withheld: string[] = [];
  for (const tool of toolNames) {
    const decision = policy.evaluate({
      tool,
      userId: null,
      role: context.role,
      sessionChannel: context.sessionChannel,
      args: {},
    });
    if (decision.action === "allow") {
      allowed.push(tool);
      continue;
    }
    withheld.push(tool);
  }
  if (withheld.length > 0) {
    log.info("delegated-tier.withheld", {
      withheld,
      role: context.role,
      sessionChannel: context.sessionChannel,
      reason: "not tiered `allow` in mcp-policy.yaml for a delegated caller",
    });
  }
  return allowed;
}
