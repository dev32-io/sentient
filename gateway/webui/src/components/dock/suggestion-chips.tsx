import type { JSX } from "preact";
import { ChipControl } from "../common/foundation.tsx";

export interface SuggestionChipsProps {
  suggestions: readonly string[];
  onClick(text: string): void;
}

export function SuggestionChips({ suggestions, onClick }: SuggestionChipsProps): JSX.Element {
  return (
    <nav class="dock-suggestions" aria-label="Suggestions">
      {suggestions.map((suggestion) => (
        <ChipControl key={suggestion} onClick={() => onClick(suggestion)}>
          {suggestion}
        </ChipControl>
      ))}
    </nav>
  );
}
