import { describe, expect, it } from "vitest";
import { LANGUAGE_DISPLAY, SUPPORTED_LANGUAGES, isSupportedLanguage, normalizeLanguage } from "./languages.ts";

describe("languages", () => {
  it("has exactly the 10 Qwen languages", () => {
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(["de", "en", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh"]);
  });
  it("isSupportedLanguage is case-insensitive and rejects unknown", () => {
    expect(isSupportedLanguage("ZH")).toBe(true);
    expect(isSupportedLanguage("ar")).toBe(false);
    expect(isSupportedLanguage("")).toBe(false);
  });
  it("normalizeLanguage lowercases supported, empties unknown", () => {
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("th")).toBe("");
    expect(normalizeLanguage("")).toBe("");
  });
  it("every supported code has a display entry", () => {
    for (const c of SUPPORTED_LANGUAGES) expect(LANGUAGE_DISPLAY[c]).toBeDefined();
  });
});
