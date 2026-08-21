import type { JSX } from "preact";
import type { CalendarMutationScope } from "../../services/calendar-api.ts";

export interface MutationScopeChooserProps {
  value?: CalendarMutationScope | undefined;
  onChange(scope: CalendarMutationScope): void;
  recurring?: boolean;
  disabled?: boolean;
  idPrefix?: string;
  describedBy?: string | undefined;
}

const OPTIONS: readonly {
  value: CalendarMutationScope;
  label: string;
  description: string;
}[] = [
  {
    value: "this_occurrence",
    label: "This occurrence",
    description: "Only the selected date changes.",
  },
  {
    value: "this_and_following",
    label: "This and following",
    description: "Split the series from the selected date onward.",
  },
  {
    value: "entire_series",
    label: "Entire series",
    description: "Apply the change to every occurrence.",
  },
];

/** Controlled, explicit recurrence mutation scope selection. */
export function MutationScopeChooser({
  value,
  onChange,
  recurring = true,
  disabled = false,
  idPrefix = "calendar-mutation-scope",
  describedBy,
}: MutationScopeChooserProps): JSX.Element | null {
  if (!recurring) return null;
  return (
    <fieldset class="calendar-editor__scope" aria-describedby={describedBy}>
      <legend class="calendar-editor__legend">Apply changes to</legend>
      <div class="calendar-editor__scope-options">
        {OPTIONS.map((option) => {
          const id = `${idPrefix}-${option.value}`;
          return (
            <label class="calendar-editor__scope-option" for={id} key={option.value}>
              <input
                id={id}
                name={idPrefix}
                type="radio"
                value={option.value}
                checked={value === option.value}
                disabled={disabled}
                onChange={() => onChange(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export const RecurrenceMutationScopeChooser = MutationScopeChooser;
