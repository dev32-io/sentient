import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../common/icon.tsx";

const DEBOUNCE_MS = 300;
const QUERY_MAX = 200;

export interface SessionSearchBoxProps {
  onChange(q: string): void;
  /**
   * Optional uncontrolled-style notification of the current input value
   * (pre-debounce). Lets the drawer render a "no matches for X" message
   * without lifting the input's value into a parent signal.
   */
  onQueryInput?(q: string): void;
}

export function SessionSearchBox({
  onChange,
  onQueryInput,
}: SessionSearchBoxProps): JSX.Element {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: onChange is stable parent ref
  useEffect(() => {
    const t = setTimeout(() => onChange(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const update = (next: string): void => {
    setQ(next);
    onQueryInput?.(next);
  };

  const clear = (): void => {
    update("");
    inputRef.current?.focus();
  };

  return (
    <div class={`session-search ${q ? "session-search--filled" : ""}`}>
      <span class="session-search__icon" aria-hidden="true">
        <Icon name="search" size={14} />
      </span>
      <input
        ref={inputRef}
        class="session-search__input"
        type="text"
        placeholder="Search past chats"
        value={q}
        maxLength={QUERY_MAX}
        onInput={(e) => update((e.currentTarget as HTMLInputElement).value)}
        aria-label="Search past chats"
      />
      {q && (
        <button
          type="button"
          class="session-search__clear"
          aria-label="Clear search"
          title="Clear"
          onClick={clear}
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
