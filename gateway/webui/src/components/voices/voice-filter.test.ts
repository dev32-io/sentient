// gateway/webui/src/components/voices/voice-filter.test.ts
import { describe, expect, it } from "vitest";
import type { VoiceSummary } from "../../services/voices-api.ts";
import { type VoiceFilterState, deriveLanguageOptions, filterPacks } from "./voice-filter.ts";

const pk = (o: Partial<VoiceSummary>): VoiceSummary => ({
  voiceId: "x",
  name: "N",
  description: "",
  tags: [],
  source: "user",
  createdAt: 0,
  refDurationMs: 0,
  language: "",
  ...o,
});

const baseFilter: VoiceFilterState = { q: "", source: "all", tags: [], language: "" };

describe("voice-filter language", () => {
  it("filters by exact language", () => {
    const packs = [pk({ language: "zh" }), pk({ language: "en" }), pk({ language: "" })];
    expect(filterPacks(packs, { ...baseFilter, language: "zh" }).length).toBe(1);
  });

  it("language '' means no language filter", () => {
    const packs = [pk({ language: "zh" }), pk({ language: "en" })];
    expect(filterPacks(packs, { ...baseFilter, language: "" }).length).toBe(2);
  });

  it("deriveLanguageOptions is the sorted unique non-empty set", () => {
    const packs = [pk({ language: "zh" }), pk({ language: "en" }), pk({ language: "" }), pk({ language: "zh" })];
    expect(deriveLanguageOptions(packs)).toEqual(["en", "zh"]);
  });
});

describe("voice-filter existing behavior", () => {
  it("still filters by source and tags and search", () => {
    const packs = [
      pk({ voiceId: "a", name: "Alpha", source: "builtin", tags: ["calm"] }),
      pk({ voiceId: "b", name: "Beta", source: "user", tags: ["bright"] }),
    ];
    expect(filterPacks(packs, { ...baseFilter, source: "builtin" }).length).toBe(1);
    expect(filterPacks(packs, { ...baseFilter, tags: ["bright"] }).length).toBe(1);
    expect(filterPacks(packs, { ...baseFilter, q: "alpha" }).length).toBe(1);
  });
});
