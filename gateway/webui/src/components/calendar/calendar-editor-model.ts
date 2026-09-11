import type {
  CalendarCreateInput,
  CalendarEvent,
  CalendarMutationCommand,
  CalendarMutationScope,
  CalendarOccurrence,
  CalendarRecurrence,
  CalendarScope,
  CalendarTime,
  CalendarUpdateChanges,
  CalendarWeekday,
} from "../../services/calendar-api.ts";
import type {
  CalendarEditorApiResult,
  CalendarEditorDraft,
  CalendarEditorError,
  CalendarEditorFrequency,
  CalendarEditorInitialDraft,
  CalendarEditorMode,
} from "./calendar-editor-types.ts";
import {
  calendarTimeFromInput,
  formatCalendarInputValue,
  parseCalendarInputWithOffset,
  rawCalendarTime,
  todayCalendarDate,
} from "./calendar-time.ts";

export const CALENDAR_EDITOR_WEEKDAYS: readonly { value: CalendarWeekday; label: string }[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

export const CALENDAR_EDITOR_FREQUENCIES: readonly { value: CalendarEditorFrequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const VALID_WEEKDAYS = new Set<CalendarWeekday>(CALENDAR_EDITOR_WEEKDAYS.map((item) => item.value));
const VALID_FREQUENCIES = new Set<CalendarEditorFrequency>(CALENDAR_EDITOR_FREQUENCIES.map((item) => item.value));

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function eventSource(
  event: CalendarEvent | CalendarOccurrence | null | undefined,
  occurrence: CalendarOccurrence | null | undefined,
): CalendarEvent | CalendarOccurrence | null {
  return event ?? occurrence ?? null;
}

export function eventIdOf(event: CalendarEvent | CalendarOccurrence | null): string | null {
  if (!event) return null;
  const value = event.eventId ?? (event as CalendarOccurrence).baseEventId ?? event.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function originalStartOf(event: CalendarEvent | CalendarOccurrence | null): CalendarTime | undefined {
  if (!event) return undefined;
  return (event as CalendarOccurrence).originalStart;
}

export function eventIsRecurring(event: CalendarEvent | CalendarOccurrence | null): boolean {
  if (!event) return false;
  return (event as CalendarOccurrence).recurring === true || event.recurrence !== undefined;
}

export function rawSourceTime(value: CalendarTime | undefined): string | undefined {
  return value === undefined ? undefined : rawCalendarTime(value);
}

export function scopeLabel(scope: CalendarScope): string {
  return scope === "household" ? "Household" : "Private";
}

export function originalEventScope(event: CalendarEvent | CalendarOccurrence | null): CalendarScope | null {
  if (!event || (event.scope !== "private" && event.scope !== "household")) return null;
  return event.scope;
}

function datePart(value: string): string {
  return value.slice(0, 10);
}

function timedInputForDate(value: string, hour: number): string {
  return `${datePart(value)}T${String(hour).padStart(2, "0")}:00`;
}

function defaultDraft(timeZoneId: string): CalendarEditorDraft {
  const today = todayCalendarDate(new Date(), timeZoneId);
  const now = new Date();
  const start = new Date(now.getTime() + 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    title: "",
    description: "",
    allDay: false,
    start: formatCalendarInputValue(start.toISOString(), timeZoneId) || timedInputForDate(today, 9),
    end: formatCalendarInputValue(end.toISOString(), timeZoneId) || timedInputForDate(today, 10),
    scope: "private",
    visibility: "everyone",
    importance: "normal",
    group: "",
    tagsText: "",
    recurrenceEnabled: false,
    recurrenceFrequency: "weekly",
    recurrenceInterval: "1",
    recurrenceWeekdays: ["monday"],
    recurrenceEnd: "count",
    recurrenceCount: "1",
    recurrenceUntil: datePart(today),
    inputTimeZoneId: timeZoneId,
  };
}

function recurrenceUntilInput(value: string, allDay: boolean, timeZoneId: string): string {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return formatCalendarInputValue(value, timeZoneId);
}

export function weekdaysForStart(value: string): CalendarWeekday {
  const date = new Date(`${datePart(value)}T12:00:00Z`);
  const sundayFirst: readonly CalendarWeekday[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return sundayFirst[date.getUTCDay()] ?? "monday";
}

export function draftFromEvent(
  source: CalendarEvent | CalendarOccurrence,
  timeZoneId: string,
  supplied?: CalendarEditorInitialDraft,
): CalendarEditorDraft {
  const allDay = source.start.kind === "all-day";
  const sourceStart = rawSourceTime(source.start);
  const sourceEnd = rawSourceTime(source.end);
  const start =
    source.start.kind === "all-day" ? source.start.date : formatCalendarInputValue(source.start.instant, timeZoneId);
  const end =
    source.end === undefined
      ? ""
      : source.end.kind === "all-day"
        ? source.end.date
        : formatCalendarInputValue(source.end.instant, timeZoneId);
  const recurrence = source.recurrence;
  const sourceUntil = recurrence?.until;
  const recurrenceEnabled = recurrence !== undefined;
  const recurrenceFrequency = recurrence?.frequency ?? "weekly";
  const recurrenceUntil =
    sourceUntil === undefined
      ? allDay
        ? start
        : datePart(start)
      : recurrenceUntilInput(sourceUntil, allDay, timeZoneId);
  const base: CalendarEditorDraft = {
    title: source.title,
    description: source.description ?? "",
    allDay,
    start,
    end,
    scope: source.scope,
    visibility: source.visibility,
    importance: source.importance,
    group: source.group ?? "",
    tagsText: source.tags.join(", "),
    recurrenceEnabled,
    recurrenceFrequency,
    recurrenceInterval: String(recurrence?.interval ?? 1),
    recurrenceWeekdays:
      recurrence?.weekdays?.filter((day): day is CalendarWeekday => VALID_WEEKDAYS.has(day)) ??
      (recurrenceFrequency === "weekly" ? [weekdaysForStart(start)] : []),
    recurrenceEnd: recurrence?.until !== undefined ? "until" : "count",
    recurrenceCount: String(recurrence?.count ?? 1),
    recurrenceUntil,
    inputTimeZoneId: timeZoneId,
    ...(source.start.kind === "timed" && source.start.timeZoneId !== undefined
      ? { eventTimeZoneId: source.start.timeZoneId }
      : {}),
    ...(sourceStart !== undefined ? { sourceStart, sourceStartInput: start } : {}),
    ...(sourceEnd !== undefined ? { sourceEnd, sourceEndInput: end } : {}),
    ...(sourceUntil !== undefined
      ? { sourceRecurrenceUntil: sourceUntil, sourceRecurrenceUntilInput: recurrenceUntil }
      : {}),
  };
  return mergeDraft(base, supplied);
}

export function mergeDraft(base: CalendarEditorDraft, supplied?: CalendarEditorInitialDraft): CalendarEditorDraft {
  if (!supplied) return base;
  const { tags, ...partial } = supplied;
  return {
    ...base,
    ...(tags !== undefined ? { tagsText: tags.join(", ") } : {}),
    ...partial,
  };
}

export function editableDraftKey(draft: CalendarEditorDraft): string {
  return JSON.stringify({
    title: draft.title,
    description: draft.description,
    allDay: draft.allDay,
    start: draft.start,
    end: draft.end,
    scope: draft.scope,
    visibility: draft.visibility,
    importance: draft.importance,
    group: draft.group,
    tagsText: draft.tagsText,
    recurrenceEnabled: draft.recurrenceEnabled,
    recurrenceFrequency: draft.recurrenceFrequency,
    recurrenceInterval: draft.recurrenceInterval,
    recurrenceWeekdays: draft.recurrenceWeekdays,
    recurrenceEnd: draft.recurrenceEnd,
    recurrenceCount: draft.recurrenceCount,
    recurrenceUntil: draft.recurrenceUntil,
    inputTimeZoneId: draft.inputTimeZoneId,
    eventTimeZoneId: draft.eventTimeZoneId,
  });
}

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function unchangedSourceTime(
  value: string,
  sourceInput: string | undefined,
  sourceValue: string | undefined,
): string | undefined {
  return sourceInput !== undefined && sourceValue !== undefined && value === sourceInput ? sourceValue : undefined;
}

function rawDraftTime(
  value: string,
  allDay: boolean,
  timeZoneId: string,
  eventTimeZoneId: string | undefined,
  sourceInput: string | undefined,
  sourceValue: string | undefined,
): { ok: true; value: string } | { ok: false; code: string; message: string } {
  const original = unchangedSourceTime(value, sourceInput, sourceValue);
  if (original !== undefined) return { ok: true, value: original };
  if (allDay) {
    const parsed = calendarTimeFromInput(value, { allDay: true, inputTimeZoneId: timeZoneId });
    if (!parsed) return { ok: false, code: "invalid_time", message: "Check the date and time values." };
    return { ok: true, value: rawCalendarTime(parsed) };
  }
  // Keep the local wall-clock offset on the wire. Calendar V2 uses it to
  // validate a recurring anchor against the configured household timezone.
  const offsetValue = parseCalendarInputWithOffset(value, eventTimeZoneId ?? timeZoneId);
  if (offsetValue === null) return { ok: false, code: "invalid_time", message: "Check the date and time values." };
  return { ok: true, value: offsetValue };
}

export function buildRecurrence(
  draft: CalendarEditorDraft,
): { ok: true; value?: CalendarRecurrence } | { ok: false; code: string; message: string } {
  if (!draft.recurrenceEnabled) return { ok: true };
  if (!VALID_FREQUENCIES.has(draft.recurrenceFrequency)) {
    return { ok: false, code: "invalid_recurrence", message: "Choose a supported repeat pattern." };
  }
  const interval = Number(draft.recurrenceInterval);
  if (!Number.isInteger(interval) || interval < 1) {
    return { ok: false, code: "invalid_recurrence", message: "Repeat interval must be at least one." };
  }
  if (draft.recurrenceFrequency === "weekly" && draft.recurrenceWeekdays.length === 0) {
    return { ok: false, code: "invalid_recurrence", message: "Choose at least one weekday." };
  }
  const recurrence: CalendarRecurrence = {
    frequency: draft.recurrenceFrequency,
    interval,
    ...(draft.recurrenceFrequency === "weekly" ? { weekdays: [...draft.recurrenceWeekdays] } : {}),
  };
  if (draft.recurrenceEnd === "count") {
    const count = Number(draft.recurrenceCount);
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, code: "invalid_recurrence", message: "Repeat count must be at least one." };
    }
    return { ok: true, value: { ...recurrence, count } };
  }
  if (!draft.recurrenceUntil) {
    return { ok: false, code: "invalid_recurrence", message: "Choose when the repeat should end." };
  }
  const until = rawDraftTime(
    draft.recurrenceUntil,
    draft.allDay,
    draft.inputTimeZoneId,
    draft.eventTimeZoneId,
    draft.sourceRecurrenceUntilInput,
    draft.sourceRecurrenceUntil,
  );
  if (!until.ok) return { ok: false, code: until.code, message: "Check the repeat end date." };
  return { ok: true, value: { ...recurrence, until: until.value } };
}

function compareRawTimes(start: string, end: string, allDay: boolean): number {
  if (allDay) return start.localeCompare(end);
  return Date.parse(start) - Date.parse(end);
}

export function buildTimes(
  draft: CalendarEditorDraft,
): { ok: true; start: string; end?: string } | { ok: false; code: string; message: string } {
  if (!draft.start) return { ok: false, code: "invalid_time", message: "Choose a start date and time." };
  const start = rawDraftTime(
    draft.start,
    draft.allDay,
    draft.inputTimeZoneId,
    draft.eventTimeZoneId,
    draft.sourceStartInput,
    draft.sourceStart,
  );
  if (!start.ok) return start;
  if (!draft.end) return { ok: true, start: start.value };
  const end = rawDraftTime(
    draft.end,
    draft.allDay,
    draft.inputTimeZoneId,
    draft.eventTimeZoneId,
    draft.sourceEndInput,
    draft.sourceEnd,
  );
  if (!end.ok) return end;
  if (compareRawTimes(start.value, end.value, draft.allDay) > 0) {
    return { ok: false, code: "invalid_range", message: "End must be on or after the start." };
  }
  return { ok: true, start: start.value, end: end.value };
}

export function buildCreateInput(
  draft: CalendarEditorDraft,
): { ok: true; value: CalendarCreateInput } | { ok: false; code: string; message: string } {
  const times = buildTimes(draft);
  if (!times.ok) return times;
  const recurrence = buildRecurrence(draft);
  if (!recurrence.ok) return recurrence;
  const value: CalendarCreateInput = {
    title: draft.title.trim(),
    ...(draft.description.trim() ? { description: draft.description } : {}),
    start: times.start,
    ...(times.end !== undefined ? { end: times.end } : {}),
    scope: draft.scope,
    visibility: draft.visibility,
    importance: draft.importance,
    ...(draft.group.trim() ? { group: draft.group.trim() } : {}),
    tags: parseTags(draft.tagsText),
    ...(recurrence.value !== undefined ? { recurrence: recurrence.value } : {}),
  };
  return { ok: true, value };
}

export function buildUpdateCommand(
  event: CalendarEvent | CalendarOccurrence | null,
  draft: CalendarEditorDraft,
  mutationScope: CalendarMutationScope | undefined,
):
  | { ok: true; eventId: string; command: Extract<CalendarMutationCommand, { operation: "update" }> }
  | { ok: false; code: string; message: string } {
  const eventId = eventIdOf(event);
  const scope = originalEventScope(event);
  if (!event || !eventId || scope === null)
    return { ok: false, code: "not_found", message: "This calendar event is no longer available." };
  if (eventIsRecurring(event) && mutationScope === undefined) {
    return { ok: false, code: "invalid_mutation_scope", message: "Choose which occurrences to update." };
  }
  const times = buildTimes(draft);
  if (!times.ok) return times;
  const recurrence = buildRecurrence(draft);
  if (!recurrence.ok) return recurrence;
  const changes: CalendarUpdateChanges = {
    title: draft.title.trim(),
    description: draft.description || null,
    start: times.start,
    end: times.end ?? null,
    visibility: draft.visibility,
    importance: draft.importance,
    group: draft.group.trim() || null,
    tags: parseTags(draft.tagsText),
  };
  const applyTo = mutationScope ?? "entire_series";
  // Compare editor-normalized recurrence values so merely opening a rule with
  // omitted defaults does not rewrite it. Occurrence patches forbid this key,
  // even when its value is null or the existing rule.
  const originalRecurrence = buildRecurrence(draftFromEvent(event, draft.inputTimeZoneId));
  const recurrenceChanged =
    !originalRecurrence.ok || JSON.stringify(recurrence.value) !== JSON.stringify(originalRecurrence.value);
  if (recurrenceChanged) {
    if (applyTo === "this_occurrence") {
      return {
        ok: false,
        code: "invalid_mutation_scope",
        message: "Choose a series scope to change the repeat pattern.",
      };
    }
    changes.recurrence = recurrence.value ?? null;
  }
  const command: Extract<CalendarMutationCommand, { operation: "update" }> = {
    operation: "update",
    applyTo,
    // Calendar V2 has no scope-change update. Always address the immutable
    // resource scope from the original event, never the editable draft.
    scope,
    changes,
  };
  if (applyTo !== "entire_series") {
    const originalStart = rawSourceTime(originalStartOf(event));
    if (originalStart === undefined) {
      return { ok: false, code: "invalid_mutation_scope", message: "The recurring occurrence has no original start." };
    }
    command.originalStart = originalStart;
  }
  if (typeof event?.revision === "number" && Number.isInteger(event.revision))
    command.expectedRevision = event.revision;
  return { ok: true, eventId, command };
}

export function buildDeleteCommand(
  event: CalendarEvent | CalendarOccurrence | null,
  _draft: CalendarEditorDraft,
  mutationScope: CalendarMutationScope | undefined,
):
  | { ok: true; eventId: string; command: Extract<CalendarMutationCommand, { operation: "delete" }> }
  | { ok: false; code: string; message: string } {
  const eventId = eventIdOf(event);
  const scope = originalEventScope(event);
  if (!eventId || scope === null)
    return { ok: false, code: "not_found", message: "This calendar event is no longer available." };
  if (eventIsRecurring(event) && mutationScope === undefined) {
    return { ok: false, code: "invalid_mutation_scope", message: "Choose which occurrences to delete." };
  }
  const applyTo = mutationScope ?? "entire_series";
  const command: Extract<CalendarMutationCommand, { operation: "delete" }> = {
    operation: "delete",
    applyTo,
    // Delete likewise uses the original resource scope; scope changes are not
    // a supported Calendar V2 mutation.
    scope,
  };
  if (applyTo !== "entire_series") {
    const originalStart = rawSourceTime(originalStartOf(event));
    if (originalStart === undefined) {
      return { ok: false, code: "invalid_mutation_scope", message: "The recurring occurrence has no original start." };
    }
    command.originalStart = originalStart;
  }
  if (typeof event?.revision === "number" && Number.isInteger(event.revision))
    command.expectedRevision = event.revision;
  return { ok: true, eventId, command };
}

export function errorMessage(code: string): string {
  switch (code) {
    case "conflict":
    case "recurrence_conflict":
      return "This event changed elsewhere. Review the latest version before saving.";
    case "forbidden":
      return "This calendar action is not permitted.";
    case "not_found":
    case "occurrence_not_found":
      return "This calendar event is no longer available.";
    case "invalid_time":
    case "invalid_range":
    case "invalid_recurrence":
    case "invalid_mutation_scope":
      return "Check the event details and try again.";
    default:
      return "The calendar could not complete that action. Your draft is still here.";
  }
}

export function typedError(code: string, status = 0, message = errorMessage(code)): CalendarEditorError {
  return { code, status: Number.isFinite(status) && status >= 0 ? status : 0, message };
}

export function errorFromResult(error: unknown): CalendarEditorError {
  if (!isRecord(error)) return typedError("api-error");
  const code = typeof error.code === "string" ? error.code : "api-error";
  const status = typeof error.status === "number" ? error.status : 0;
  return typedError(code, status);
}

export function isApiResult(value: unknown): value is CalendarEditorApiResult {
  return isRecord(value) && typeof value.ok === "boolean";
}

export function resultOperation(request: { operation: "create" | "update" | "delete" }):
  | "create"
  | "update"
  | "delete" {
  return request.operation;
}

export function initialDraftFor(
  source: CalendarEvent | CalendarOccurrence | null,
  mode: CalendarEditorMode,
  timeZoneId: string,
  supplied?: CalendarEditorInitialDraft,
): CalendarEditorDraft {
  if (mode === "edit" && source) {
    // Scope is an immutable resource identity for edits. A create draft may
    // choose it, but an edit draft never accepts a caller-provided replacement.
    return { ...draftFromEvent(source, timeZoneId, supplied), scope: source.scope };
  }
  return mergeDraft(defaultDraft(timeZoneId), supplied);
}

export function inputDateForToggle(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? datePart(value) : "";
}
