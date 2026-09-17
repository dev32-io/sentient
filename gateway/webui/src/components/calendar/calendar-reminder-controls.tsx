import type { JSX } from "preact";
import { Field, SelectControl, ToggleControl } from "../common/index.ts";
import type { CalendarEditorDraft } from "./calendar-editor-types.ts";

export interface CalendarReminderControlsProps {
  draft: CalendarEditorDraft;
  formId: string;
  onChange(patch: Partial<CalendarEditorDraft>): void;
}

/** Pure reminder leaf embedded by the existing event editor. */
export function CalendarReminderControls({ draft, formId, onChange }: CalendarReminderControlsProps): JSX.Element {
  return <section class="calendar-editor__reminder calendar-editor__field--wide" aria-labelledby={`${formId}-reminder-label`}>
    <div class="calendar-editor__reminder-head"><div><strong id={`${formId}-reminder-label`}>Personal reminder</strong><span>Only you receive this reminder. It does not change event visibility.</span></div><ToggleControl label="Personal reminder" checked={draft.reminderEnabled} onChange={(reminderEnabled) => onChange({ reminderEnabled, ...(reminderEnabled && draft.allDay ? { reminderMode: "all-day" } : {}) })} /></div>
    {draft.reminderEnabled && (draft.allDay ? <Field label="Reminder time" type="time" required value={draft.reminderLocalTime} hint={`Uses ${draft.inputTimeZoneId}`} onInput={(event) => onChange({ reminderLocalTime: event.currentTarget.value })} /> : <><SelectControl label="Remind me" value={draft.reminderMode === "lead" ? "lead" : "at-start"} options={[{ value: "at-start", label: "At event start" }, { value: "lead", label: "Before event starts" }]} onChange={(value) => onChange({ reminderMode: value === "lead" ? "lead" : "at-start" })} />{draft.reminderMode === "lead" && <Field label="Minutes before" type="number" inputMode="numeric" required value={draft.reminderLeadMinutes} onInput={(event) => onChange({ reminderLeadMinutes: event.currentTarget.value })} />}</>)}
  </section>;
}
