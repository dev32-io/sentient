import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../common/icon.tsx";
import { Field, FoundationIconButton } from "../common/foundation.tsx";

const DEBOUNCE_MS = 300;
const QUERY_MAX = 200;

export interface SessionSearchBoxProps {
  onChange(q: string): void;
  /** Increment to clear the input from an external recovery action. */
  clearSignal?: number | undefined;
  /** Optional uncontrolled-style notification of the current input value (pre-debounce). */
  onQueryInput?(q: string): void;
}

export function SessionSearchBox({
  onChange,
  clearSignal,
  onQueryInput,
}: SessionSearchBoxProps): JSX.Element {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: onChange is stable parent ref
  useEffect(() => {
    const t = setTimeout(() => onChange(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (clearSignal === undefined) return;
    setQ("");
    onQueryInput?.("");
    inputRef.current?.focus();
  }, [clearSignal]);

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
      <Field
        inputRef={inputRef}
        className="session-search__field"
        inputClassName="session-search__input"
        type="search"
        placeholder="Search past chats"
        value={q}
        maxLength={QUERY_MAX}
        onInput={(event) => update(event.currentTarget.value)}
        ariaLabel="Search past chats"
      />
      {q && (
        <FoundationIconButton label="Clear search" variant="quiet" className="session-search__clear" onClick={clear}>
          <Icon name="x" size={14} />
        </FoundationIconButton>
      )}
    </div>
  );
}
