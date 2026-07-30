// Which tools a DELEGATED agent (Hermes, today) is allowed to hold.
//
// WHY THIS IS THE ONLY CONTROL. The delegated agent dials MCP servers itself
// — the owner ruled a gateway proxy over-complicated for today's value — so
// the gateway's PDP/PEP never observes those calls: no `confirm` prompt, no
// argument-value check, no abort. `delegateTask` exists to go read the web,
// which is a prompt-injection surface, so an injected page telling the
// sub-agent to unlock a door would otherwise execute unmediated. The tier
// filter below is therefore the whole security boundary, not an optimisation.
//
// DERIVED, NEVER LISTED. The set comes from `gateway/mcp-policy.yaml` through
// the same `PolicyEngine` the gateway's own loop uses. A second hardcoded
// spelling of "which tools are safe" is a thing that must agree with the
// policy file and eventually will not — the exact defect class this codebase
// has already paid for twice. A tool that matches NO rule resolves to
// `confirm` (policy-engine's `UNMATCHED`) and is therefore dropped: inheriting
// the fail-closed default is the point.
//
// The proper answer — a permission surface for delegated tools tuned
// independently of Sentient's own tool settings — is recorded in
// `docs/native-todo.md` § D11 as its own later design.

import { getLog } from "../logging/logger.js";
import type { PolicyEngine } from "../security/policy-engine.js";

const log = getLog(["sentient", "external-tools", "delegated-tier"]);

/**
 * The policy context a delegated tool call is evaluated under.
 *
 * MUST match `bootstrap/create-mcp-host.ts`'s `contextFor`, or the surface the
 * gateway advertises to the delegated agent and the surface it will actually
 * execute disagree — a tool listed but denied at call time, or worse the
 * reverse. `userId` is null because tiering is a property of the tool, not of
 * who is asking; no shipped rule reads `userId`.
 */
const DELEGATED_ROLE = "user" as const;
const DELEGATED_CHANNEL = "voice" as const;

/**
 * Narrow `toolNames` to the tools the shipped policy tiers `allow` for a
 * delegated caller. Order is preserved so callers get a stable, loggable set.
 */
export function selectDelegatedAllowTier(policy: PolicyEngine, toolNames: readonly string[]): string[] {
  const allowed: string[] = [];
  const withheld: string[] = [];
  for (const tool of toolNames) {
    const decision = policy.evaluate({
      tool,
      userId: null,
      role: DELEGATED_ROLE,
      sessionChannel: DELEGATED_CHANNEL,
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
      reason: "not tiered `allow` in mcp-policy.yaml; a delegated call has no PDP prompt to mediate it",
    });
  }
  return allowed;
}
