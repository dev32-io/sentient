import { isSupportedLanguage } from "@sentient/config";

export type PreviewGreetings = Record<string, readonly string[]>;

const FALLBACK = "Hello.";

/** Pick a random greeting in `lang` (a supported code), else English, else
 *  any non-empty list, else a bare "Hello." — never throws on empty config. */
export function pickPreviewGreeting(greetings: PreviewGreetings, lang: string): string {
  const key = isSupportedLanguage(lang) ? lang.toLowerCase() : "en";
  const list =
    (greetings[key]?.length ? greetings[key] : greetings.en) ?? Object.values(greetings).find((l) => l.length);
  if (!list || list.length === 0) return FALLBACK;
  return list[Math.floor(Math.random() * list.length)] ?? FALLBACK;
}
