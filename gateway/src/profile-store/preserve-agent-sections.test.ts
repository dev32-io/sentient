import { describe, expect, it } from "vitest";
import { preserveAgentSections } from "./preserve-agent-sections.js";

const RENDERED = "model:\n  provider: openrouter\nagent:\n  reasoning_effort: minimal\nmcp_servers: {}\n";

// INVARIANT: the config.yaml the gateway renders for hermes never carries an
// empty-bodied personality.
//
// This was harmless only while defect D11 made that file dead output. With the
// gateway MCP registered the file is live, so an empty body is a live blank
// system prompt, and `extractList`'s body-match then reports an arbitrary
// entry as the active personality. Older builds already wrote such entries
// (`personalities: {e2e-test: ""}` was live on this repo's dev box), so the
// splice must DROP them rather than faithfully carry them forward — that is
// what makes an existing install converge on the next boot re-render.
describe("preserveAgentSections", () => {
  it("drops an empty-bodied personality an older build left behind", () => {
    const existing = 'agent:\n  personalities:\n    keep: Be calm.\n    stale: ""\n';
    const merged = preserveAgentSections(RENDERED, existing);
    expect(merged).toContain("keep");
    expect(merged).not.toContain("stale");
  });

  it("drops the personalities map entirely when every entry is empty", () => {
    const existing = 'agent:\n  personalities:\n    stale: ""\n';
    const merged = preserveAgentSections(RENDERED, existing);
    expect(merged).not.toContain("stale");
    expect(merged).not.toContain("personalities");
  });

  it("carries a non-empty personality library through unchanged", () => {
    const existing = "agent:\n  personalities:\n    calm: Be calm.\n  system_prompt: Be calm.\n";
    const merged = preserveAgentSections(RENDERED, existing);
    expect(merged).toContain("calm: Be calm.");
    expect(merged).toContain("system_prompt: Be calm.");
  });
});
