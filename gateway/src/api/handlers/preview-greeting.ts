import { isSupportedLanguage } from "@sentient/config";

export type PreviewGreetings = Record<string, readonly string[]>;

const FALLBACK = "Hello.";

/** Pick a random greeting in `lang` (a supported code), else English, else
 *  any non-empty list, else a bare "Hello." — never throws on empty config. */
export function pickPreviewGreeting(greetings: PreviewGreetings, lang: string): string {
  const key = isSupportedLanguage(lang) ? lang.toLowerCase() : "en";
  // Each step gates on a NON-EMPTY list — an empty `[]` is not nullish, so a
  // present-but-empty `en` must still fall through to any populated language.
  const list =
    (greetings[key]?.length ? greetings[key] : undefined) ??
    (greetings.en?.length ? greetings.en : undefined) ??
    Object.values(greetings).find((l) => l.length) ??
    [];
  if (list.length === 0) return FALLBACK;
  return list[Math.floor(Math.random() * list.length)] ?? FALLBACK;
}
