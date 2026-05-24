// gateway/webui/src/components/settings/panes/voice-langs.ts
//
// User-friendly display for ISO language codes returned by Fish Audio.
// Fish returns lowercase 2-letter codes ("en", "ja"); we render flag + name
// in the language dropdown to match fish.audio/app/discovery's UX.

export interface LangDisplay {
  flag: string;
  name: string;
}

const LANG_MAP: Record<string, LangDisplay> = {
  en: { flag: "🇺🇸", name: "English" },
  ja: { flag: "🇯🇵", name: "Japanese" },
  zh: { flag: "🇨🇳", name: "Chinese" },
  ko: { flag: "🇰🇷", name: "Korean" },
  es: { flag: "🇪🇸", name: "Spanish" },
  fr: { flag: "🇫🇷", name: "French" },
  de: { flag: "🇩🇪", name: "German" },
  pt: { flag: "🇵🇹", name: "Portuguese" },
  it: { flag: "🇮🇹", name: "Italian" },
  ru: { flag: "🇷🇺", name: "Russian" },
  ar: { flag: "🇸🇦", name: "Arabic" },
  hi: { flag: "🇮🇳", name: "Hindi" },
  id: { flag: "🇮🇩", name: "Indonesian" },
  nl: { flag: "🇳🇱", name: "Dutch" },
  pl: { flag: "🇵🇱", name: "Polish" },
  tr: { flag: "🇹🇷", name: "Turkish" },
  vi: { flag: "🇻🇳", name: "Vietnamese" },
  th: { flag: "🇹🇭", name: "Thai" },
  cy: { flag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", name: "Welsh" },
};

export function langDisplay(code: string): LangDisplay {
  return LANG_MAP[code.toLowerCase()] ?? { flag: "🌐", name: code.toUpperCase() };
}
