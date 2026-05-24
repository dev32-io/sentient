import type { JSX } from "preact";

export interface SuggestionChipsProps {
  suggestions: readonly string[];
  onClick(text: string): void;
}

export function SuggestionChips({ suggestions, onClick }: SuggestionChipsProps): JSX.Element {
  return (
    <div class="suggestion-chips">
      {suggestions.map((s) => (
        <button key={s} type="button" class="suggestion-chips__item" onClick={() => onClick(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}
