// Which tools a DELEGATED agent (Hermes, today) is allowed to hold.
//
// TWO TIERS, DIFFERENT IN KIND (owner, 2026-07-30). The user's own MCP setup —
// whatever they or Hermes configure, by hand or through an LLM — is never ours
// to touch. On top of it the gateway PROVIDES a second tier through its own
// per-user MCP socket: the tools it hosts in-process, plus a proxy over the
// operator's `mcp_catalog`. This module decides what may enter that second
// tier, and nothing else.
//
// DERIVED FROM THE IMPACT TIER, NEVER LISTED. The set comes from each tool's
// `tier`, declared once by the operator in `config.yaml#mcp_catalog` and read
// by everything that has an opinion about who may run what — the role gate, the
// per-role permission template, and this. A second hardcoded spelling of "which
// tools are safe" is a thing that must agree with the catalog and eventually
// will not: the exact defect class this codebase has already paid for twice,
// and the reason `gateway/mcp-policy.yaml` — a whole second, name-keyed
// classification of the same tools — is gone.
//
// WHY THE READ TIER, AND WHY THE TWO PATHS DIFFER. A delegated call arrives
// with NO HUMAN ATTACHED, so anything that would resolve to a prompt cannot be
// answered. The gateway's own hosted tools execute inside
// `mcp-host/mcp-server.ts`, which has no confirmation mechanism at all — for
// those this filter IS the boundary. A PROXIED catalog tool executes through
// `tools/tool-broker.ts`, whose `ask` branch fails closed for a delegated
// broker (`ConfirmUnavailableError`), so for those the filter decides what the
// socket ADVERTISES and the broker is the boundary. Either way the advertised
// surface must match the surface that would actually execute.
//
// The proper answer — a permission surface for delegated tools tuned
// independently of Sentient's own tool settings — is recorded in
// `docs/native-todo.md` § 1 as its own later design.

import type { ImpactTier } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "external-tools", "delegated-tier"]);

/** The shape this module needs of a tool: its name, and the operator's impact
 *  tier for it. Structural on purpose — a `ToolHandler` joined to its catalog
 *  tier and an `McpToolRef` are both this, without either caller converting to
 *  a type owned by the other. */
export interface DelegatableTool {
  readonly name: string;
  readonly tier: ImpactTier;
}

/**
 * Whether a tool of this tier may be held by an agent nobody is watching.
 *
 * EXHAUSTIVE, no `default:` arm. A fifth tier must be decided by whoever adds
 * it: falling through to `true` hands an unsupervised agent a tool nobody meant
 * to give it, and that is the one direction this file exists to prevent.
 *
 * `read` is the whole answer, and it is the same fact stated three ways: every
 * role reaches it (`ROLE_PERMISSIONS`), the role template resolves it `allow`
 * (`tools/role-defaults.ts`), and therefore no call of it can ever need a
 * person. Every other tier resolves to `ask` by default, and `ask` with nobody
 * attached is a deny — so advertising one would promise a tool that cannot run.
 */
function isDelegatable(tier: ImpactTier): boolean {
  switch (tier) {
    case "read":
      return true;
    case "write":
      return false;
    case "confirm":
      return false;
    case "admin":
      return false;
  }
}

/**
 * Narrow `tools` to the ones a delegated agent may hold. Order is preserved so
 * callers get a stable, loggable set, and the ELEMENTS are returned rather than
 * their names so a caller does not have to re-join them to anything.
 */
export function selectDelegatedTools<T extends DelegatableTool>(tools: readonly T[]): T[] {
  const allowed: T[] = [];
  // `name:tier` tokens, not objects: `logging/format.ts`'s `formatValue` runs
  // `String(value)` on any non-string, so an array of objects renders as the
  // literal `[object Object]`.
  const withheld: string[] = [];
  for (const tool of tools) {
    if (isDelegatable(tool.tier)) {
      allowed.push(tool);
      continue;
    }
    withheld.push(`${tool.name}:${tool.tier}`);
  }
  if (withheld.length > 0) {
    log.info("delegated-tier.withheld", {
      withheldCount: withheld.length,
      withheld: withheld.join(" "),
      reason: "above the read tier, so a delegated call would need a person to confirm it and none is attached",
    });
  }
  return allowed;
}
