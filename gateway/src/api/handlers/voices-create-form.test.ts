import { describe, expect, it } from "bun:test";
import { parseCreateForm } from "./voices-create-form.ts";

const caps = { descriptionMaxLen: 240, tagMaxLen: 24, maxTags: 8 };
function form(fields: Record<string, string>, withAudio = true): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (withAudio) fd.set("audio", new Blob([new Uint8Array([1, 2, 3])]), "r.wav");
  return new Request("http://x/api/v1/voices", { method: "POST", body: fd });
}

describe("parseCreateForm language", () => {
  it("keeps a supported language (case-insensitive)", async () => {
    const r = await parseCreateForm(caps, form({ name: "Nova", language: "ZH" }));
    expect(r.ok && r.value.language).toBe("zh");
  });
  it("drops an unsupported language to empty", async () => {
    const r = await parseCreateForm(caps, form({ name: "Nova", language: "th" }));
    expect(r.ok && r.value.language).toBe("");
  });
  it("defaults to empty when absent", async () => {
    const r = await parseCreateForm(caps, form({ name: "Nova" }));
    expect(r.ok && r.value.language).toBe("");
  });
});
