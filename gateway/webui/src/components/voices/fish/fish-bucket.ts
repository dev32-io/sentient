// gateway/webui/src/components/voices/fish/fish-bucket.ts
//
// Pure helpers for the Fish clone panel's faceted-search UX. The voice catalog
// returned by Fish carries flat `tags[]` strings (e.g. ["female", "young",
// "warm"]); these helpers split them into Gender / Age / Vibe buckets that
// drive separate filter rows. All comparisons are case-insensitive against
// the canonical bucket vocabularies below; display preserves Fish's casing.
//
// Fish data is dirty — the same logical value shows up with mixed casing
// across voices ("Male" vs "male", "Young" vs "young"). We dedupe by
// lowercase key and emit a single canonical display label per bucket so the
// filter rows don't show ghost-duplicates.

import type { FishVoiceEntry } from "../../../services/fish-api.ts";

export type TagBucket = "gender" | "age" | "vibe";

const GENDER_TAGS = new Set(["male", "female"]);
const AGE_ORDER = ["young", "middle-aged", "old"];
const AGE_TAGS = new Set(AGE_ORDER);

export function bucketTag(tag: string): TagBucket {
  const k = tag.trim().toLowerCase();
  if (GENDER_TAGS.has(k)) return "gender";
  if (AGE_TAGS.has(k)) return "age";
  return "vibe";
}

function canonicalGender(k: string): string {
  return k === "male" ? "Male" : "Female";
}

function canonicalAge(k: string): string {
  if (k === "middle-aged") return "Middle-aged";
  return k.charAt(0).toUpperCase() + k.slice(1);
}

export interface FilterOptions {
  languages: string[];
  genders: string[];
  ages: string[];
  vibes: string[];
}

export function deriveFilterOptions(voices: FishVoiceEntry[]): FilterOptions {
  const languages = new Set<string>();
  // Map<lowercase-key, displayLabel> — preserves first-seen casing for vibes,
  // canonical capitalization for gender/age.
  const genders = new Map<string, string>();
  const ages = new Map<string, string>();
  const vibes = new Map<string, string>();
  for (const v of voices) {
    for (const l of v.languages) languages.add(l);
    for (const t of v.tags) {
      const k = t.trim().toLowerCase();
      const b = bucketTag(t);
      if (b === "gender") {
        if (!genders.has(k)) genders.set(k, canonicalGender(k));
      } else if (b === "age") {
        if (!ages.has(k)) ages.set(k, canonicalAge(k));
      } else {
        if (!vibes.has(k)) vibes.set(k, t.trim());
      }
    }
  }
  return {
    languages: [...languages].sort(),
    genders: [...genders.values()].sort(),
    ages: [...ages.values()].sort(sortAgeOrder),
    vibes: [...vibes.values()].sort((a, b) => a.localeCompare(b)),
  };
}

// Age reads more naturally young → old than alphabetic.
function sortAgeOrder(a: string, b: string): number {
  const ia = AGE_ORDER.indexOf(a.toLowerCase());
  const ib = AGE_ORDER.indexOf(b.toLowerCase());
  if (ia !== -1 && ib !== -1) return ia - ib;
  return a.localeCompare(b);
}

// Tile vibe-tags use whatever casing Fish gave us per voice; the chip row
// uses the deduped first-seen casing. When the user clicks a tile-tag, map
// it to the canonical chip value so toggle/active checks match.
export function canonicalizeVibe(t: string, options: FilterOptions): string {
  const k = t.trim().toLowerCase();
  return options.vibes.find((v) => v.toLowerCase() === k) ?? t;
}

export type SortKey = "popular" | "recent" | "az";

export interface VoiceFilters {
  q: string;
  language: string; // "" or "all" = no filter
  genders: string[];
  ages: string[];
  vibes: string[];
}

export function isAnyFilterActive(f: VoiceFilters): boolean {
  return (
    f.q.trim() !== "" ||
    (f.language !== "" && f.language !== "all") ||
    f.genders.length > 0 ||
    f.ages.length > 0 ||
    f.vibes.length > 0
  );
}

// Client-side facet filter. Title search is handled server-side via Fish's
// `?title=` query, so `f.q` is intentionally ignored here.
export function applyFilters(voices: FishVoiceEntry[], f: VoiceFilters): FishVoiceEntry[] {
  const langActive = f.language !== "" && f.language !== "all";
  const tagSets = {
    g: new Set(f.genders.map((t) => t.toLowerCase())),
    a: new Set(f.ages.map((t) => t.toLowerCase())),
    v: new Set(f.vibes.map((t) => t.toLowerCase())),
  };
  return voices.filter((voice) => {
    if (langActive && !voice.languages.includes(f.language)) return false;
    if (tagSets.g.size > 0 || tagSets.a.size > 0 || tagSets.v.size > 0) {
      const lowerSet = new Set(voice.tags.map((t) => t.toLowerCase()));
      if (tagSets.g.size > 0 && !hasAny(lowerSet, tagSets.g)) return false;
      if (tagSets.a.size > 0 && !hasAny(lowerSet, tagSets.a)) return false;
      if (tagSets.v.size > 0 && !hasAny(lowerSet, tagSets.v)) return false;
    }
    return true;
  });
}

function hasAny(haystack: Set<string>, needles: Set<string>): boolean {
  for (const n of needles) if (haystack.has(n)) return true;
  return false;
}

export function sortVoices(voices: FishVoiceEntry[], sort: SortKey): FishVoiceEntry[] {
  if (sort === "popular") return voices; // server already returns by score
  const out = [...voices];
  if (sort === "recent") {
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }
  // az
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

export function toggleInArray(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];
}

export interface BucketedTags {
  gender: string | null;
  age: string | null;
  vibes: string[];
}

export function bucketVoiceTags(tags: string[]): BucketedTags {
  let gender: string | null = null;
  let age: string | null = null;
  const vibes: string[] = [];
  for (const t of tags) {
    const b = bucketTag(t);
    if (b === "gender" && !gender) gender = t;
    else if (b === "age" && !age) age = t;
    else if (b === "vibe") vibes.push(t);
  }
  return { gender, age, vibes };
}
