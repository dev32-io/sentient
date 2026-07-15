// gateway/webui/src/components/voices/fish/fish-bucket.test.ts
import { describe, expect, it } from "vitest";
import type { FishVoiceEntry } from "../../../services/fish-api.ts";
import { deriveFilterOptions } from "./fish-bucket.ts";

const voice = (o: Partial<FishVoiceEntry>): FishVoiceEntry => ({
  id: "x",
  title: "N",
  description: "",
  languages: [],
  tags: [],
  coverImageUrl: null,
  previewAudioUrl: null,
  visibility: "public",
  taskCount: 0,
  createdAt: "",
  ...o,
});

describe("deriveFilterOptions language filter", () => {
  it("excludes languages Qwen doesn't support", () => {
    const voices = [voice({ languages: ["en", "ar"] }), voice({ languages: ["th", "zh"] })];
    expect(deriveFilterOptions(voices).languages).toEqual(["en", "zh"]);
  });

  it("keeps all 10 Qwen-supported languages when present", () => {
    const voices = [
      voice({ languages: ["zh", "en", "ja", "ko", "de"] }),
      voice({ languages: ["fr", "ru", "pt", "es", "it"] }),
    ];
    expect(deriveFilterOptions(voices).languages).toEqual(["de", "en", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh"]);
  });
});
