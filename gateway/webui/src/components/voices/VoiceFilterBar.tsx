// gateway/webui/src/components/voices/VoiceFilterBar.tsx
import type { JSX } from "preact";
import { LANGUAGE_DISPLAY } from "@sentient/config";
import { ChipControl, SearchFilterBar, SegmentedControl, SelectMenu, type SegmentedOption, type SelectMenuOption } from "../common/index.ts";
import type { VoiceSource } from "./voice-filter.ts";

const SOURCE_OPTIONS: SegmentedOption[] = [
  { value: "all", label: "All" },
  { value: "builtin", label: "Built-in" },
  { value: "user", label: "Yours" },
];

export interface VoiceFilterBarProps {
  q: string;
  source: VoiceSource;
  activeTags: string[];
  allTags: string[];
  language: string;
  allLanguages: string[];
  onQ: (v: string) => void;
  onSource: (v: VoiceSource) => void;
  onToggleTag: (tag: string) => void;
  onLanguage: (v: string) => void;
}

/** Presentational voice-list filter bar: search + source segmented control + language select + tag chips. */
export function VoiceFilterBar(props: VoiceFilterBarProps): JSX.Element {
  const langOptions: SelectMenuOption[] = [
    { value: "", label: "All languages" },
    ...props.allLanguages.map((code) => ({
      value: code,
      label: `${LANGUAGE_DISPLAY[code]?.flag ?? "🌐"} ${LANGUAGE_DISPLAY[code]?.name ?? code}`,
    })),
  ];
  return (
    <SearchFilterBar
      value={props.q}
      onChange={props.onQ}
      label="Search voices"
      placeholder="Search voices"
      filtersLabel="Voice filters"
      filters={(
        <>
          <SegmentedControl label="Voice source" value={props.source} onChange={(value) => props.onSource(value as VoiceSource)} options={SOURCE_OPTIONS} />
          {props.allTags.map((tag) => (
            <ChipControl key={tag} selected={props.activeTags.includes(tag)} onClick={() => props.onToggleTag(tag)}>
              {tag}
            </ChipControl>
          ))}
        </>
      )}
    >
      <SelectMenu className="snt-filter-bar__sort" placeholder="Language" value={props.language} onChange={props.onLanguage} options={langOptions} />
    </SearchFilterBar>
  );
}
