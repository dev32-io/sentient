// gateway/webui/src/components/voices/fish/fish-langs.ts
//
// User-friendly display for ISO language codes returned by Fish Audio.
// Fish returns lowercase 2-letter codes ("en", "ja"); we render flag + name
// in the language dropdown to match fish.audio/app/discovery's UX.
//
// Delegates to the shared LANGUAGE_DISPLAY map (@sentient/config) — the same
// map used by the voice-pack filter/badge — so there's ONE source of truth
// for flag/name display. Fish's browse list can still return codes outside
// that 10-language set (ar/hi/th/…); the 🌐 fallback keeps those rendering
// here even though they're outside what local-tts actually supports.

import { LANGUAGE_DISPLAY, type LanguageDisplay } from "@sentient/config";

export type LangDisplay = LanguageDisplay;

export function langDisplay(code: string): LangDisplay {
  return LANGUAGE_DISPLAY[code.toLowerCase()] ?? { flag: "🌐", name: code.toUpperCase() };
}
