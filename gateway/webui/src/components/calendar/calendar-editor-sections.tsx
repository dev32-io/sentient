import type { JSX } from "preact";
import type { CalendarEvent, CalendarMutationScope, CalendarOccurrence, CalendarScope } from "../../services/calendar-api.ts";
import { ActionButton } from "../common/index.ts";
import { calendarCapabilityAllows, type CalendarAccessCapabilities } from "./calendar-access.ts";
import {
  CALENDAR_EDITOR_FREQUENCIES,
  CALENDAR_EDITOR_WEEKDAYS,
  eventIsRecurring,
  scopeLabel,
  weekdaysForStart,
} from "./calendar-editor-model.ts";
import type { CalendarEditorDraft, CalendarEditorError, CalendarEditorFrequency, CalendarEditorMode } from "./calendar-editor-types.ts";
import {
  CalendarCheckboxField,
  CalendarReadOnlyField,
  CalendarSelectField,
  CalendarTextArea,
  CalendarTextField,
} from "./calendar-editor-fields.tsx";
import { MutationScopeChooser } from "./mutation-scope-chooser.tsx";

export type CalendarDraftChange = (patch: Partial<CalendarEditorDraft>) => void;

export interface CalendarEditorBasicsSectionProps {
  readonly draft: CalendarEditorDraft;
  readonly formId: string;
  readonly titleRef: { current: HTMLInputElement | null };
  readonly onChange: CalendarDraftChange;
}

export function CalendarEditorBasicsSection({ draft, formId, titleRef, onChange }: CalendarEditorBasicsSectionProps): JSX.Element {
  return (
    <>
      <CalendarTextField
        id={`${formId}-title`}
        className="calendar-editor__field calendar-editor__field--wide"
        label="Event title"
        inputRef={titleRef}
        type="text"
        value={draft.title}
        maxLength={240}
        required
        onInput={(event) => onChange({ title: event.currentTarget.value })}
      />
      <CalendarTextArea
        id={`${formId}-description`}
        className="calendar-editor__field calendar-editor__field--wide"
        label="Description"
        rows={3}
        inputClassName="calendar-editor__textarea"
        value={draft.description}
        onInput={(event) => onChange({ description: event.currentTarget.value })}
      />
    </>
  );
}

export interface CalendarEditorDateTimeSectionProps {
  readonly draft: CalendarEditorDraft;
  readonly formId: string;
  readonly onChange: CalendarDraftChange;
  readonly onToggleAllDay: (checked: boolean) => void;
}

export function CalendarEditorDateTimeSection({ draft, formId, onChange, onToggleAllDay }: CalendarEditorDateTimeSectionProps): JSX.Element {
  return (
    <section class="calendar-editor__date-time" aria-labelledby={`${formId}-date-time`}>
      <header>
        <strong id={`${formId}-date-time`}>Date and time</strong>
        <CalendarCheckboxField
          className="calendar-editor__check"
          label="All day"
          checked={draft.allDay}
          onChange={onToggleAllDay}
        />
      </header>
      <span class="calendar-editor__hint">{draft.allDay ? "Date-only event" : `Times use ${draft.inputTimeZoneId}`}</span>
      <div class="calendar-editor__date-grid">
        <CalendarTextField
          id={`${formId}-start`}
          className="calendar-editor__field"
          label={draft.allDay ? "Start date" : "Start"}
          type={draft.allDay ? "date" : "datetime-local"}
          value={draft.start}
          required
          onInput={(event) => onChange({ start: event.currentTarget.value })}
        />
        <CalendarTextField
          id={`${formId}-end`}
          className="calendar-editor__field"
          label={draft.allDay ? "End date" : "End"}
          type={draft.allDay ? "date" : "datetime-local"}
          value={draft.end}
          ariaLabel={draft.allDay ? "End date (optional)" : "End (optional)"}
          onInput={(event) => onChange({ end: event.currentTarget.value })}
        />
      </div>
    </section>
  );
}

export interface CalendarEditorMetadataSectionProps {
  readonly draft: CalendarEditorDraft;
  readonly formId: string;
  readonly mode: CalendarEditorMode;
  readonly capabilities?: CalendarAccessCapabilities;
  readonly onChange: CalendarDraftChange;
}

export function CalendarEditorMetadataSection({ draft, formId, mode, capabilities, onChange }: CalendarEditorMetadataSectionProps): JSX.Element {
  const saveAction = mode === "create" ? "create" : "update";
  const scopeOptions: readonly { value: string; label: string; disabled?: boolean }[] = [
    { value: "private", label: "Private", disabled: !calendarCapabilityAllows(capabilities, saveAction, "private") },
    { value: "household", label: "Household", disabled: !calendarCapabilityAllows(capabilities, saveAction, "household") },
  ];
  return (
    <>
      {mode === "create" ? (
        <CalendarSelectField
          id={`${formId}-scope`}
          className="calendar-editor__field"
          label="Calendar"
          value={draft.scope}
          options={scopeOptions}
          onChange={(value) => onChange({ scope: value as CalendarScope })}
        />
      ) : (
        <CalendarReadOnlyField id={`${formId}-scope`} className="calendar-editor__field" label="Calendar" value={scopeLabel(draft.scope)} />
      )}
      <CalendarSelectField
        id={`${formId}-visibility`}
        className="calendar-editor__field"
        label="Visibility"
        value={draft.visibility}
        options={[{ value: "everyone", label: "Everyone" }, { value: "adults", label: "Adults only" }]}
        onChange={(value) => onChange({ visibility: value as CalendarEditorDraft["visibility"] })}
      />
      <CalendarSelectField
        id={`${formId}-importance`}
        className="calendar-editor__field"
        label="Importance"
        value={draft.importance}
        options={[{ value: "normal", label: "Normal" }, { value: "important", label: "Important" }, { value: "pinned", label: "Pinned" }]}
        onChange={(value) => onChange({ importance: value as CalendarEditorDraft["importance"] })}
      />
      <CalendarTextField
        id={`${formId}-group`}
        className="calendar-editor__field"
        label="Group"
        type="text"
        value={draft.group}
        maxLength={80}
        placeholder="Optional group"
        onInput={(event) => onChange({ group: event.currentTarget.value })}
      />
      <CalendarTextField
        id={`${formId}-tags`}
        className="calendar-editor__field calendar-editor__field--wide"
        label="Tags"
        type="text"
        value={draft.tagsText}
        placeholder="family, school"
        hint="Separate tags with commas."
        onInput={(event) => onChange({ tagsText: event.currentTarget.value })}
      />
    </>
  );
}

export interface CalendarEditorRecurrenceSectionProps {
  readonly draft: CalendarEditorDraft;
  readonly formId: string;
  readonly onChange: CalendarDraftChange;
}

export function CalendarEditorRecurrenceSection({ draft, formId, onChange }: CalendarEditorRecurrenceSectionProps): JSX.Element {
  const recurrenceValue = draft.recurrenceEnabled ? draft.recurrenceFrequency : "none";
  return (
    <>
      <CalendarSelectField
        id={`${formId}-recurrence`}
        className="calendar-editor__field calendar-editor__field--wide"
        label="Repeat"
        value={recurrenceValue}
        options={[{ value: "none", label: "Does not repeat" }, ...CALENDAR_EDITOR_FREQUENCIES]}
        onChange={(next) => {
          if (next === "none") {
            onChange({ recurrenceEnabled: false });
          } else if (CALENDAR_EDITOR_FREQUENCIES.some((frequency) => frequency.value === next)) {
            const frequency = next as CalendarEditorFrequency;
            onChange({
              recurrenceEnabled: true,
              recurrenceFrequency: frequency,
              ...(frequency === "weekly" ? { recurrenceWeekdays: [weekdaysForStart(draft.start)] } : {}),
            });
          }
        }}
      />
      {draft.recurrenceEnabled && (
        <section class="calendar-editor__recurrence calendar-editor__field--wide" aria-label="Recurrence details">
          <div class="calendar-editor__inline-fields">
            <div class="calendar-editor__input-with-suffix">
              <CalendarTextField
                id={`${formId}-recurrence-interval`}
                className="calendar-editor__field"
                label="Every"
                type="number"
                value={draft.recurrenceInterval}
                onInput={(event) => onChange({ recurrenceInterval: event.currentTarget.value })}
              />
              <span>{draft.recurrenceFrequency === "daily" ? "day(s)" : draft.recurrenceFrequency === "weekly" ? "week(s)" : draft.recurrenceFrequency === "monthly" ? "month(s)" : "year(s)"}</span>
            </div>
          </div>
          {draft.recurrenceFrequency === "weekly" && (
            <fieldset class="calendar-editor__weekdays">
              <legend class="calendar-editor__legend">On these days</legend>
              <div class="calendar-editor__weekday-grid">
                {CALENDAR_EDITOR_WEEKDAYS.map((weekday) => {
                  const checked = draft.recurrenceWeekdays.includes(weekday.value);
                  return (
                    <CalendarCheckboxField
                      className="calendar-editor__weekday"
                      label={weekday.label.slice(0, 3)}
                      checked={checked}
                      onChange={() => onChange({ recurrenceWeekdays: checked ? draft.recurrenceWeekdays.filter((value) => value !== weekday.value) : [...draft.recurrenceWeekdays, weekday.value] })}
                      key={weekday.value}
                    />
                  );
                })}
              </div>
            </fieldset>
          )}
          <CalendarSelectField
            id={`${formId}-recurrence-end`}
            className="calendar-editor__field"
            label="Ends"
            value={draft.recurrenceEnd}
            options={[{ value: "count", label: "After a number of occurrences" }, { value: "until", label: "On a date" }]}
            onChange={(value) => onChange({ recurrenceEnd: value === "until" ? "until" : "count" })}
          />
          {draft.recurrenceEnd === "count" ? (
            <CalendarTextField
              id={`${formId}-recurrence-count`}
              className="calendar-editor__field"
              label="Occurrences"
              type="number"
              value={draft.recurrenceCount}
              onInput={(event) => onChange({ recurrenceCount: event.currentTarget.value })}
            />
          ) : (
            <CalendarTextField
              id={`${formId}-recurrence-until`}
              className="calendar-editor__field"
              label="Repeat until"
              type={draft.allDay ? "date" : "datetime-local"}
              value={draft.recurrenceUntil}
              onInput={(event) => onChange({ recurrenceUntil: event.currentTarget.value })}
            />
          )}
        </section>
      )}
    </>
  );
}

export interface CalendarEditorScopeSectionProps {
  readonly source: CalendarEvent | CalendarOccurrence | null;
  readonly value: CalendarMutationScope | undefined;
  readonly conflict: boolean;
  readonly busy: boolean;
  readonly formId: string;
  readonly onChange: (scope: CalendarMutationScope) => void;
}

export function CalendarEditorScopeSection({ source, value, conflict, busy, formId, onChange }: CalendarEditorScopeSectionProps): JSX.Element | null {
  if (!eventIsRecurring(source)) return null;
  return (
    <MutationScopeChooser
      value={value}
      onChange={onChange}
      recurring
      disabled={busy}
      idPrefix={`${formId}-mutation-scope`}
      describedBy={conflict ? `${formId}-conflict` : undefined}
    />
  );
}

export interface CalendarEditorFeedbackProps {
  readonly error: CalendarEditorError | null;
  readonly conflict: boolean;
  readonly formErrorId: string;
  readonly conflictId: string;
  readonly reviewBusy: boolean;
  readonly latestEvent: CalendarEvent | CalendarOccurrence | null;
  readonly onReviewLatest: () => void;
}

export function CalendarEditorFeedback({ error, conflict, formErrorId, conflictId, reviewBusy, latestEvent, onReviewLatest }: CalendarEditorFeedbackProps): JSX.Element {
  const hasLatestRevision = latestEvent?.revision !== undefined;
  return (
    <>
      {error && (
        <div id={formErrorId} class="calendar-editor__error" role="alert" aria-live="polite">
          <p>{error.message}</p>
          {conflict && (
            <div id={conflictId} class="calendar-editor__conflict-actions">
              <ActionButton
                className="app-dialog__btn app-dialog__btn--ghost"
                disabled={reviewBusy}
                onClick={() => onReviewLatest()}
              >
                {reviewBusy ? "Reviewing…" : "Review latest"}
              </ActionButton>
              {hasLatestRevision && <span>Latest saved revision: {latestEvent?.revision}</span>}
            </div>
          )}
        </div>
      )}
      {latestEvent && (
        <div class="calendar-editor__latest" role="status">
          <span class="calendar-editor__eyebrow">Latest saved version</span>
          <strong>{latestEvent.title}</strong>
          {hasLatestRevision && <span>Revision {latestEvent.revision}</span>}
        </div>
      )}
    </>
  );
}
