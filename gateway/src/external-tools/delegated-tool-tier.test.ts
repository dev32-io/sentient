import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "../security/policy-engine.js";
import { loadMcpPolicy } from "../security/policy-loader.js";
import { selectDelegatedAllowTier } from "./delegated-tool-tier.js";

// SECURITY BOUNDARY, on one of the two delegated paths. For tools the gateway
// HOSTS, mcp-server.ts auto-approves a confirm decision, so this filter is the
// only control on what authority a sub-agent inherits. (For PROXIED catalog
// tools the broker fails closed on confirm and the PDP genuinely mediates every
// call — see proxied-catalog-tool.ts.) It runs against the SHIPPED
// mcp-policy.yaml on purpose: a rule edit that promotes a write tool into the
// delegated surface must fail here, not in production.
describe("selectDelegatedAllowTier", () => {
  const policy = createPolicyEngine(loadMcpPolicy());

  it("keeps a tool the shipped policy tiers allow", () => {
    expect(selectDelegatedAllowTier(policy, ["pause_audio", "resume_audio"])).toEqual(["pause_audio", "resume_audio"]);
  });

  it("drops a confirm-tier tool because a delegated call has no one to prompt", () => {
    expect(selectDelegatedAllowTier(policy, ["update_user_settings"])).toEqual([]);
  });

  it("drops identify_user, whose only non-deny rule is confirm", () => {
    expect(selectDelegatedAllowTier(policy, ["identify_user"])).toEqual([]);
  });

  it("drops a tool no rule classifies, inheriting the fail-closed default", () => {
    expect(selectDelegatedAllowTier(policy, ["search_images"])).toEqual([]);
  });
});
