import { describe, expect, it, vi } from "vitest";
import type { WizardDeps } from "../../step-pipeline.ts";
import { voiceStep } from "../voice.ts";

function makeDeps(
  setFishAudioKey: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, value: undefined })),
): WizardDeps {
  return { secretsStore: { setFishAudioKey } } as unknown as WizardDeps;
}

describe("voiceStep", () => {
  it("parses { skip: true }", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ skip: true }) });
    const result = await voiceStep.parse(req);
    expect(result.ok).toBe(true);
  });

  it("parses { api_key }", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ api_key: "k" }) });
    const result = await voiceStep.parse(req);
    expect(result.ok).toBe(true);
  });

  it("apply with skip:true does NOT write key", async () => {
    const setFishAudioKey = vi.fn();
    const deps = makeDeps(setFishAudioKey);
    await voiceStep.apply(deps, { skip: true });
    expect(setFishAudioKey).not.toHaveBeenCalled();
  });

  it("apply with api_key writes the key", async () => {
    const setFishAudioKey = vi.fn(async () => ({ ok: true, value: undefined }));
    const deps = makeDeps(setFishAudioKey);
    await voiceStep.apply(deps, { api_key: "fish-key" });
    expect(setFishAudioKey).toHaveBeenCalledWith("fish-key");
  });
});
