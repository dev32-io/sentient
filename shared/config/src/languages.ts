// Canonical list of the languages Qwen3-TTS (the local-tts engine) supports.
// SINGLE SOURCE OF TRUTH — imported by the gateway (validation) and webui
// (dropdown + filter + tile badge). The service keeps a tiny Python mirror
// (see LocalTTSService/src/local_tts/languages.py) since TS can't cross into
// Python. Fish Audio returns codes outside this set (ar/hi/th/…) — those are
// dropped to "" on import (normalizeLanguage).

export interface LanguageDisplay {
  readonly flag: string;
  readonly name: string;
}

export const LANGUAGE_DISPLAY: Record<string, LanguageDisplay> = {
  zh: { flag: "🇨🇳", name: "Chinese" },
  en: { flag: "🇺🇸", name: "English" },
  ja: { flag: "🇯🇵", name: "Japanese" },
  ko: { flag: "🇰🇷", name: "Korean" },
  de: { flag: "🇩🇪", name: "German" },
  fr: { flag: "🇫🇷", name: "French" },
  ru: { flag: "🇷🇺", name: "Russian" },
  pt: { flag: "🇵🇹", name: "Portuguese" },
  es: { flag: "🇪🇸", name: "Spanish" },
  it: { flag: "🇮🇹", name: "Italian" },
};

export const SUPPORTED_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_DISPLAY);

export function isSupportedLanguage(code: string): boolean {
  return code !== "" && Object.hasOwn(LANGUAGE_DISPLAY, code.toLowerCase());
}

/** Lowercased code if supported, else "" (drops Fish's unsupported langs). */
export function normalizeLanguage(code: string): string {
  const c = code.toLowerCase();
  return isSupportedLanguage(c) ? c : "";
}
