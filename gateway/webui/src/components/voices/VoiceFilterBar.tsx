// gateway/webui/src/components/voices/VoiceFilterBar.tsx
import type { JSX } from "preact";
import { LANGUAGE_DISPLAY } from "@sentient/config";
import { Chip } from "../settings/primitives/chip.tsx";
import { SearchField } from "../settings/primitives/search-field.tsx";
import { Segmented, type SegmentedOption } from "../settings/primitives/segmented.tsx";
import { Select, type SelectOption } from "../settings/primitives/select.tsx";
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
  const langOptions: SelectOption[] = [
    { value: "", label: "All languages" },
    ...props.allLanguages.map((code) => ({
      value: code,
      label: `${LANGUAGE_DISPLAY[code]?.flag ?? "🌐"} ${LANGUAGE_DISPLAY[code]?.name ?? code}`,
    })),
  ];
  return (
    <div class="voice-filter">
      <div class="voice-filter-row">
        <SearchField
          value={props.q}
          onChange={(e) => props.onQ((e.target as HTMLInputElement).value)}
          placeholder="Search voices"
          fullWidth
        />
        <Select value={props.language} onChange={props.onLanguage} options={langOptions} />
        <Segmented value={props.source} onChange={(v) => props.onSource(v as VoiceSource)} options={SOURCE_OPTIONS} />
      </div>
      {props.allTags.length > 0 && (
        <div class="voice-filter-tags">
          {props.allTags.map((tag) => (
            <Chip key={tag} active={props.activeTags.includes(tag)} onClick={() => props.onToggleTag(tag)}>
              {tag}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
