// gateway/webui/src/components/voices/voice-filter.ts
import type { VoiceSummary } from "../../services/voices-api.ts";

export type VoiceSource = "all" | "builtin" | "user";

export interface VoiceFilterState {
  q: string;
  source: VoiceSource;
  tags: string[];
}

/** Sorted union of every tag across packs. */
export function deriveTagOptions(packs: VoiceSummary[]): string[] {
  const set = new Set<string>();
  for (const p of packs) for (const t of p.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Source filter + all-selected-tags-present + case-insensitive search over name+description+tags. */
export function filterPacks(packs: VoiceSummary[], f: VoiceFilterState): VoiceSummary[] {
  const q = f.q.trim().toLowerCase();
  return packs.filter((p) => {
    if (f.source !== "all" && p.source !== f.source) return false;
    if (f.tags.length > 0 && !f.tags.every((t) => p.tags.includes(t))) return false;
    if (q === "") return true;
    const hay = [p.name, p.description, ...p.tags].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
