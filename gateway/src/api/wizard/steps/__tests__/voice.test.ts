import { describe, expect, it } from "vitest";
import type { WizardDeps } from "../../step-pipeline.ts";
import { voiceStep } from "../voice.ts";

function makeDeps(): WizardDeps {
  return {} as unknown as WizardDeps;
}

describe("voiceStep", () => {
  it("parses an empty body", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({}) });
    const result = await voiceStep.parse(req);
    expect(result.ok).toBe(true);
  });

  it("parses a legacy body with unknown fields (stripped, not rejected)", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ skip: true, api_key: "k" }) });
    const result = await voiceStep.parse(req);
    expect(result.ok).toBe(true);
  });

  it("apply acknowledges without touching secretsStore", async () => {
    const deps = makeDeps();
    const result = await voiceStep.apply(deps, {});
    expect(result.ok).toBe(true);
  });
});
