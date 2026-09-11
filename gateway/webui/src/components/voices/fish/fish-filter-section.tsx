import type { JSX } from "preact";
import { ChipControl } from "../../common/index.ts";
import { toggleInArray } from "./fish-bucket.ts";

export interface VoiceFilterSectionProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export function VoiceFilterSection({
  label,
  options,
  selected,
  onChange,
}: VoiceFilterSectionProps): JSX.Element | null {
  if (options.length === 0) return null;
  return (
    <div class="v-filter-row">
      <span class="v-filter-label">{label}</span>
      <div class="v-filter-chips">
        {options.map((opt) => (
          <ChipControl key={opt} selected={selected.includes(opt)} onClick={() => onChange(toggleInArray(selected, opt))}>
            {opt}
          </ChipControl>
        ))}
      </div>
    </div>
  );
}
