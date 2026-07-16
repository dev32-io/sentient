// gateway/webui/src/components/voices/fish/fish-toolbar.tsx
//
// Co-located helper for FishClonePanel — the search/language/sort toolbar
// row plus the Gender/Age/Vibe facet-filter rows. Extracted purely to keep
// FishClonePanel.tsx under the 300-line file cap (clean-code.md); it owns no
// state of its own, just renders the row for whatever filters/sort state the
// panel hands it.

import type { Dispatch, StateUpdater } from "preact/hooks";
import type { JSX } from "preact";
import { SearchField } from "../../settings/primitives/search-field.tsx";
import { Select } from "../../settings/primitives/select.tsx";
import { Chip } from "../../settings/primitives/chip.tsx";
import { VoiceFilterSection } from "./fish-filter-section.tsx";
import { langDisplay } from "./fish-langs.ts";
import { toggleInArray, type FilterOptions, type SortKey, type VoiceFilters } from "./fish-bucket.ts";

const VIBE_COLLAPSED_COUNT = 8;

const SORT_OPTIONS = [
  { value: "popular", label: "Popular" },
  { value: "recent", label: "Recent" },
  { value: "az", label: "A–Z" },
];

export interface FishToolbarProps {
  filters: VoiceFilters;
  setFilters: Dispatch<StateUpdater<VoiceFilters>>;
  sort: SortKey;
  setSort: (s: SortKey) => void;
  options: FilterOptions;
  vibesExpanded: boolean;
  setVibesExpanded: Dispatch<StateUpdater<boolean>>;
}

export function FishToolbar({
  filters,
  setFilters,
  sort,
  setSort,
  options,
  vibesExpanded,
  setVibesExpanded,
}: FishToolbarProps): JSX.Element {
  const langOptions = [
    { value: "all", label: "All languages" },
    ...options.languages.map((code) => {
      const d = langDisplay(code);
      return { value: code, label: `${d.flag} ${d.name}` };
    }),
  ];

  // Pin selected vibes to the head of the visible list so a click-to-toggle
  // doesn't visually "lose" them behind the +N more button.
  const selectedVibes = filters.vibes;
  const room = Math.max(0, VIBE_COLLAPSED_COUNT - selectedVibes.length);
  const head = options.vibes.filter((v) => !selectedVibes.includes(v)).slice(0, room);
  const visibleVibes = vibesExpanded ? options.vibes : [...selectedVibes, ...head];
  const hiddenVibeCount = options.vibes.length - visibleVibes.length;

  return (
    <>
      <div class="v-toolbar">
        <SearchField
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: (e.target as HTMLInputElement).value }))}
          placeholder="Search voices…"
        />
        <Select
          value={filters.language}
          onChange={(l) => setFilters((f) => ({ ...f, language: l }))}
          options={langOptions}
        />
        <Select value={sort} onChange={(s) => setSort(s as SortKey)} options={SORT_OPTIONS} />
      </div>

      <div class="v-filters">
        <VoiceFilterSection
          label="Gender"
          options={options.genders}
          selected={filters.genders}
          onChange={(g) => setFilters((f) => ({ ...f, genders: g }))}
        />
        <VoiceFilterSection
          label="Age"
          options={options.ages}
          selected={filters.ages}
          onChange={(a) => setFilters((f) => ({ ...f, ages: a }))}
        />
        {options.vibes.length > 0 && (
          <div class="v-filter-row">
            <span class="v-filter-label">Tags</span>
            <div class="v-filter-chips">
              {visibleVibes.map((t) => (
                <Chip
                  key={t}
                  active={filters.vibes.includes(t)}
                  onClick={() => setFilters((f) => ({ ...f, vibes: toggleInArray(f.vibes, t) }))}
                >
                  {t}
                </Chip>
              ))}
              {hiddenVibeCount > 0 && !vibesExpanded && (
                <button type="button" class="v-tag-toggle" onClick={() => setVibesExpanded(true)}>
                  +{hiddenVibeCount} more
                </button>
              )}
              {vibesExpanded && options.vibes.length > VIBE_COLLAPSED_COUNT && (
                <button type="button" class="v-tag-toggle" onClick={() => setVibesExpanded(false)}>
                  Less
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
