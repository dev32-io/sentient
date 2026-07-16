import type { JSX } from "preact";

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedProps {
  value: string;
  onChange: (v: string) => void;
  options: SegmentedOption[];
  disabled?: boolean;
}

export function Segmented({ value, onChange, options, disabled }: SegmentedProps): JSX.Element {
  return (
    <div class="seg2" role="group">
      {options.map((o) => {
        const isActive = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            class={isActive ? "on" : undefined}
            // The visual ".on" class alone is invisible to the accessibility
            // tree (no focus/selection semantics), which desyncs from the
            // actual `value` the instant DOM focus moves elsewhere (e.g. a
            // modal opening elsewhere on the page) even though the CSS
            // highlight itself never changes. aria-pressed is derived fresh
            // from `value` on every render, so it stays correct through any
            // focus or lifecycle change — never a separate piece of state to
            // fall out of sync.
            aria-pressed={isActive}
            onClick={() => onChange(o.value)}
            disabled={disabled}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
