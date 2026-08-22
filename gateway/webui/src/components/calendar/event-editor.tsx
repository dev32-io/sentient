import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  CalendarApi,
  CalendarCreateInput,
  CalendarEvent,
  CalendarGetResult,
  CalendarMutationCommand,
  CalendarMutationResult,
  CalendarMutationScope,
  CalendarOccurrence,
  CalendarRecurrence,
  CalendarTime,
  CalendarUpdateChanges,
  CalendarWeekday,
  CalendarVisibility,
  CalendarImportance,
  CalendarScope,
  CalendarApiResult,
} from "../../services/calendar-api.ts";
import {
  browserTimeZone,
  calendarTimeFromInput,
  formatCalendarInputValue,
  parseCalendarInputWithOffset,
  rawCalendarTime,
  todayCalendarDate,
} from "./calendar-time.ts";
import { Dialog, type DialogCloseReason } from "../common/dialog.tsx";
import { DeleteConfirmation } from "./delete-confirmation.tsx";
import { MutationScopeChooser } from "./mutation-scope-chooser.tsx";
import {
  calendarCapabilityAllows,
  type CalendarAccessCapabilities,
} from "./calendar-access.ts";
import "./event-editor.css";

export type CalendarEditorMode = "create" | "edit";
export type CalendarEditorFrequency = CalendarRecurrence["frequency"];

export interface CalendarEditorDraft {
  title: string;
  description: string;
  allDay: boolean;
  start: string;
  end: string;
  scope: CalendarScope;
  visibility: CalendarVisibility;
  importance: CalendarImportance;
  group: string;
  tagsText: string;
  recurrenceEnabled: boolean;
  recurrenceFrequency: CalendarEditorFrequency;
  recurrenceInterval: string;
  recurrenceWeekdays: CalendarWeekday[];
  recurrenceEnd: "count" | "until";
  recurrenceCount: string;
  recurrenceUntil: string;
  /** The device zone used by native datetime-local controls. */
  inputTimeZoneId: string;
  /** Compatibility/source zone retained for helper conversion only. */
  eventTimeZoneId?: string;
  /** Raw source values let unchanged fields round-trip without normalization. */
  sourceStart?: string;
  sourceEnd?: string;
  sourceStartInput?: string;
  sourceEndInput?: string;
  sourceRecurrenceUntil?: string;
  sourceRecurrenceUntilInput?: string;
}

export type CalendarEditorInitialDraft = Partial<CalendarEditorDraft> & {
  /** Convenience input for callers that already have normalized tags. */
  tags?: readonly string[];
};

export interface CalendarEditorCreateRequest {
  readonly operation: "create";
  readonly input: CalendarCreateInput;
}

export interface CalendarEditorUpdateRequest {
  readonly operation: "update";
  readonly eventId: string;
  readonly command: Extract<CalendarMutationCommand, { operation: "update" }>;
}

export interface CalendarEditorDeleteRequest {
  readonly operation: "delete";
  readonly eventId: string;
  readonly command: Extract<CalendarMutationCommand, { operation: "delete" }>;
}

export type CalendarEditorRequest =
  | CalendarEditorCreateRequest
  | CalendarEditorUpdateRequest
  | CalendarEditorDeleteRequest;

export interface CalendarEditorError {
  readonly code: string;
  readonly status: number;
  /** Sanitized UI copy; server reason/message text is never displayed. */
  readonly message: string;
}

export type CalendarEditorOutcome =
  | {
      readonly kind: "success";
      readonly operation: CalendarEditorRequest["operation"];
      readonly request: CalendarEditorRequest;
      readonly result: CalendarEvent | CalendarMutationResult;
      readonly successorEventId?: string;
    }
  | {
      readonly kind: "failure";
      readonly operation: CalendarEditorRequest["operation"];
      readonly request: CalendarEditorRequest;
      readonly error: CalendarEditorError;
      readonly draft: CalendarEditorDraft;
    }
  | {
      readonly kind: "submitted";
      readonly operation: CalendarEditorRequest["operation"];
      readonly request: CalendarEditorRequest;
    };

export type CalendarEditorApiResult = CalendarApiResult<CalendarEvent | CalendarMutationResult>;
export type CalendarEditorCallbackResult = CalendarEditorApiResult | void | Promise<CalendarEditorApiResult | void>;

export interface EventEditorProps {
  /** Controlled visibility. Defaults to true for leaf-component use. */
  open?: boolean;
  mode?: CalendarEditorMode;
  event?: CalendarEvent | CalendarOccurrence | null;
  /** Alias accepted by preview integrations. */
  occurrence?: CalendarOccurrence | null;
  api?: CalendarApi;
  token?: string;
  capabilities?: CalendarAccessCapabilities;
  inputTimeZoneId?: string;
  initialDraft?: CalendarEditorInitialDraft;
  onClose?(): void;
  onCancel?(): void;
  onOpenChange?(open: boolean): void;
  onSubmit?(request: CalendarEditorRequest): CalendarEditorCallbackResult;
  onCommand?(request: CalendarEditorRequest): CalendarEditorCallbackResult;
  onCreate?(input: CalendarCreateInput): CalendarEditorCallbackResult;
  onUpdate?(eventId: string, command: Extract<CalendarMutationCommand, { operation: "update" }>): CalendarEditorCallbackResult;
  onDelete?(eventId: string, command: Extract<CalendarMutationCommand, { operation: "delete" }>): CalendarEditorCallbackResult;
  onOutcome?(outcome: CalendarEditorOutcome): void;
  onSuccess?(result: CalendarEvent | CalendarMutationResult, request: CalendarEditorRequest): void;
  onFailure?(error: CalendarEditorError, draft: CalendarEditorDraft, request: CalendarEditorRequest): void;
  onSubmitted?(request: CalendarEditorRequest): void;
  onReread?(eventId: string, options: { scope: CalendarScope; originalStart?: string }): CalendarApiResult<CalendarGetResult> | void | Promise<CalendarApiResult<CalendarGetResult> | void>;
}

const WEEKDAYS: readonly { value: CalendarWeekday; label: string }[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

const FREQUENCIES: readonly { value: CalendarEditorFrequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const VALID_WEEKDAYS = new Set<CalendarWeekday>(WEEKDAYS.map((item) => item.value));
const VALID_FREQUENCIES = new Set<CalendarEditorFrequency>(FREQUENCIES.map((item) => item.value));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function eventSource(
  event: CalendarEvent | CalendarOccurrence | null | undefined,
  occurrence: CalendarOccurrence | null | undefined,
): CalendarEvent | CalendarOccurrence | null {
  return event ?? occurrence ?? null;
}

function eventIdOf(event: CalendarEvent | CalendarOccurrence | null): string | null {
  if (!event) return null;
  const value = event.eventId ?? (event as CalendarOccurrence).baseEventId ?? event.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function originalStartOf(event: CalendarEvent | CalendarOccurrence | null): CalendarTime | undefined {
  if (!event) return undefined;
  const value = (event as CalendarOccurrence).originalStart;
  return value;
}

function eventIsRecurring(event: CalendarEvent | CalendarOccurrence | null): boolean {
  if (!event) return false;
  return (event as CalendarOccurrence).recurring === true || event.recurrence !== undefined;
}

function rawSourceTime(value: CalendarTime | undefined): string | undefined {
  return value === undefined ? undefined : rawCalendarTime(value);
}

function scopeLabel(scope: CalendarScope): string {
  return scope === "household" ? "Household" : "Private";
}

function originalEventScope(event: CalendarEvent | CalendarOccurrence | null): CalendarScope | null {
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

function weekdaysForStart(value: string): CalendarWeekday {
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

function draftFromEvent(
  source: CalendarEvent | CalendarOccurrence,
  timeZoneId: string,
  supplied?: CalendarEditorInitialDraft,
): CalendarEditorDraft {
  const allDay = source.start.kind === "all-day";
  const sourceStart = rawSourceTime(source.start);
  const sourceEnd = rawSourceTime(source.end);
  const start = source.start.kind === "all-day" ? source.start.date : formatCalendarInputValue(source.start.instant, timeZoneId);
  const end = source.end === undefined
    ? ""
    : source.end.kind === "all-day"
      ? source.end.date
      : formatCalendarInputValue(source.end.instant, timeZoneId);
  const recurrence = source.recurrence;
  const sourceUntil = recurrence?.until;
  const recurrenceEnabled = recurrence !== undefined;
  const recurrenceFrequency = recurrence?.frequency ?? "weekly";
  const recurrenceUntil = sourceUntil === undefined
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
    recurrenceWeekdays: recurrence?.weekdays?.filter((day): day is CalendarWeekday => VALID_WEEKDAYS.has(day))
      ?? (recurrenceFrequency === "weekly" ? [weekdaysForStart(start)] : []),
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

function mergeDraft(base: CalendarEditorDraft, supplied?: CalendarEditorInitialDraft): CalendarEditorDraft {
  if (!supplied) return base;
  const { tags, ...partial } = supplied;
  return {
    ...base,
    ...(tags !== undefined ? { tagsText: tags.join(", ") } : {}),
    ...partial,
  };
}

function editableDraftKey(draft: CalendarEditorDraft): string {
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
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
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

function buildRecurrence(
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

function buildTimes(
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

function buildCreateInput(draft: CalendarEditorDraft):
  | { ok: true; value: CalendarCreateInput }
  | { ok: false; code: string; message: string } {
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

function buildUpdateCommand(
  event: CalendarEvent | CalendarOccurrence | null,
  draft: CalendarEditorDraft,
  mutationScope: CalendarMutationScope | undefined,
): { ok: true; eventId: string; command: Extract<CalendarMutationCommand, { operation: "update" }> } | { ok: false; code: string; message: string } {
  const eventId = eventIdOf(event);
  const scope = originalEventScope(event);
  if (!eventId || scope === null) return { ok: false, code: "not_found", message: "This calendar event is no longer available." };
  if (eventIsRecurring(event) && mutationScope === undefined) {
    return { ok: false, code: "invalid_mutation_scope", message: "Choose which occurrences to update." };
  }
  const times = buildTimes(draft);
  if (!times.ok) return times;
  const recurrence = buildRecurrence(draft);
  if (!recurrence.ok) return recurrence;
  const changes: CalendarUpdateChanges = {
    title: draft.title.trim(),
    description: draft.description,
    start: times.start,
    end: times.end ?? null,
    visibility: draft.visibility,
    importance: draft.importance,
    group: draft.group.trim() || null,
    tags: parseTags(draft.tagsText),
    recurrence: recurrence.value ?? null,
  };
  const applyTo = mutationScope ?? "entire_series";
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
  if (typeof event?.revision === "number" && Number.isInteger(event.revision)) command.expectedRevision = event.revision;
  return { ok: true, eventId, command };
}

function buildDeleteCommand(
  event: CalendarEvent | CalendarOccurrence | null,
  draft: CalendarEditorDraft,
  mutationScope: CalendarMutationScope | undefined,
): { ok: true; eventId: string; command: Extract<CalendarMutationCommand, { operation: "delete" }> } | { ok: false; code: string; message: string } {
  void draft; // retained in the helper signature for source compatibility
  const eventId = eventIdOf(event);
  const scope = originalEventScope(event);
  if (!eventId || scope === null) return { ok: false, code: "not_found", message: "This calendar event is no longer available." };
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
  if (typeof event?.revision === "number" && Number.isInteger(event.revision)) command.expectedRevision = event.revision;
  return { ok: true, eventId, command };
}

function errorMessage(code: string): string {
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

function typedError(code: string, status = 0, message = errorMessage(code)): CalendarEditorError {
  return { code, status: Number.isFinite(status) && status >= 0 ? status : 0, message };
}

function errorFromResult(error: unknown): CalendarEditorError {
  if (!isRecord(error)) return typedError("api-error");
  const code = typeof error.code === "string" ? error.code : "api-error";
  const status = typeof error.status === "number" ? error.status : 0;
  return typedError(code, status);
}

function isApiResult(value: unknown): value is CalendarEditorApiResult {
  return isRecord(value) && typeof value.ok === "boolean";
}

function resultOperation(request: CalendarEditorRequest): "create" | "update" | "delete" {
  return request.operation;
}

function initialDraftFor(
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

function inputDateForToggle(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? datePart(value) : "";
}

export function EventEditor({
  open = true,
  mode: suppliedMode,
  event,
  occurrence,
  api,
  token = "",
  capabilities,
  inputTimeZoneId = browserTimeZone(),
  initialDraft,
  onClose,
  onCancel,
  onOpenChange,
  onSubmit,
  onCommand,
  onCreate,
  onUpdate,
  onDelete,
  onOutcome,
  onSuccess,
  onFailure,
  onSubmitted,
  onReread,
}: EventEditorProps): JSX.Element | null {
  const source = eventSource(event, occurrence);
  const mode = suppliedMode ?? (source ? "edit" : "create");
  const sourceId = eventIdOf(source);
  const sourceOccurrenceId = source && "occurrenceId" in source ? source.occurrenceId : "";
  const suppliedDraftKey = initialDraft ? JSON.stringify(initialDraft) : "";
  const targetKey = `${mode}:${sourceId ?? "new"}:${sourceOccurrenceId}:${source?.revision ?? ""}:${suppliedDraftKey}`;
  const titleRef = useRef<HTMLInputElement | null>(null);
  const formId = useRef(`calendar-editor-form-${Math.random().toString(36).slice(2, 9)}`);
  const previousTarget = useRef<string | null>(null);
  const baseline = useRef("");
  const [draft, setDraft] = useState<CalendarEditorDraft>(() => initialDraftFor(source, mode, inputTimeZoneId, initialDraft));
  const [mutationScope, setMutationScope] = useState<CalendarMutationScope | undefined>(() =>
    mode === "edit" && eventIsRecurring(source) ? undefined : "entire_series",
  );
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [error, setError] = useState<CalendarEditorError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latestEvent, setLatestEvent] = useState<CalendarGetResult | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      previousTarget.current = null;
      return;
    }
    if (previousTarget.current === targetKey) return;
    previousTarget.current = targetKey;
    const next = initialDraftFor(source, mode, inputTimeZoneId, initialDraft);
    setDraft(next);
    baseline.current = editableDraftKey(next);
    setMutationScope(mode === "edit" && eventIsRecurring(source) ? undefined : "entire_series");
    setBusy(false);
    setDeleteOpen(false);
    setDiscardOpen(false);
    setError(null);
    setConflict(false);
    setLatestEvent(null);
    setReviewBusy(false);
  }, [inputTimeZoneId, initialDraft, mode, open, source, targetKey]);

  if (!open || (mode === "edit" && !source)) return null;

  const dirty = baseline.current !== editableDraftKey(draft);
  const saveAction = mode === "create" ? "create" : "update";
  const resourceScope = mode === "edit" ? originalEventScope(source) : draft.scope;
  const canSave = resourceScope !== null && calendarCapabilityAllows(capabilities, saveAction, resourceScope)
    && !busy
    && !(mode === "edit" && eventIsRecurring(source) && mutationScope === undefined);
  const canDelete = mode === "edit" && resourceScope !== null && calendarCapabilityAllows(capabilities, "delete", resourceScope) && !busy;
  const setDraftValue = (partial: Partial<CalendarEditorDraft>): void => {
    setDraft((current) => ({ ...current, ...partial }));
    setError(null);
    setConflict(false);
  };

  const closeEditor = (force = false): void => {
    // A successful mutation clears busy immediately before the callbacks
    // below, but the closure still contains the previous render's `busy`
    // value. Success is an approved close path and must not leave a hidden
    // nested confirmation dialog mounted behind inert background content.
    if (busy && !force) return;
    onCancel?.();
    onClose?.();
    onOpenChange?.(false);
  };

  const requestClose = (_reason: DialogCloseReason): void => {
    if (busy) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    closeEditor();
  };

  const validationFailure = (
    request: CalendarEditorRequest | null,
    failure: { code: string; message: string },
  ): void => {
    const next = typedError(failure.code, 0, failure.message);
    setError(next);
    if (request) {
      const outcome: CalendarEditorOutcome = { kind: "failure", operation: resultOperation(request), request, error: next, draft };
      onOutcome?.(outcome);
      onFailure?.(next, draft, request);
    }
  };

  const executeRequest = async (request: CalendarEditorRequest): Promise<CalendarEditorApiResult | null> => {
    const callback = request.operation === "create"
      ? onCreate
        ? ((): CalendarEditorCallbackResult => onCreate(request.input))
        : onSubmit ?? onCommand
      : request.operation === "update"
        ? onUpdate
          ? ((): CalendarEditorCallbackResult => onUpdate(request.eventId, request.command))
          : onSubmit ?? onCommand
        : onDelete
          ? ((): CalendarEditorCallbackResult => onDelete(request.eventId, request.command))
          : onSubmit ?? onCommand;
    if (callback) {
      try {
        const delegated = await callback(request as never);
        if (isApiResult(delegated)) return delegated;
        if (!api) return null;
      } catch {
        return { ok: false, error: { status: 0, code: "api-error" } };
      }
    }
    if (!api) return null;
    try {
      if (request.operation === "create") return await api.create(token, request.input);
      return await api.mutate(token, request.eventId, request.command);
    } catch {
      return { ok: false, error: { status: 0, code: "api-error" } };
    }
  };

  const handleResult = async (request: CalendarEditorRequest): Promise<void> => {
    setBusy(true);
    setError(null);
    setConflict(false);
    const result = await executeRequest(request);
    if (!result) {
      setBusy(false);
      onSubmitted?.(request);
      onOutcome?.({ kind: "submitted", operation: request.operation, request });
      return;
    }
    setBusy(false);
    if (!result.ok) {
      const next = errorFromResult(result.error);
      setError(next);
      setConflict(next.code === "conflict" || next.code === "recurrence_conflict");
      const outcome: CalendarEditorOutcome = { kind: "failure", operation: request.operation, request, error: next, draft };
      onOutcome?.(outcome);
      onFailure?.(next, draft, request);
      if (request.operation === "delete") setDeleteOpen(false);
      return;
    }
    const value = result.value;
    const successorEventId = "successorEventId" in value && typeof value.successorEventId === "string"
      ? value.successorEventId
      : undefined;
    const outcome: CalendarEditorOutcome = {
      kind: "success",
      operation: request.operation,
      request,
      result: value,
      ...(successorEventId !== undefined ? { successorEventId } : {}),
    };
    onOutcome?.(outcome);
    onSuccess?.(value, request);
    closeEditor(true);
  };

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (!draft.title.trim()) {
      validationFailure(null, { code: "validation", message: "Add a title before saving." });
      return;
    }
    if (resourceScope === null || !calendarCapabilityAllows(capabilities, saveAction, resourceScope)) {
      validationFailure(null, { code: "forbidden", message: "This calendar action is not permitted." });
      return;
    }
    if (mode === "create") {
      const input = buildCreateInput(draft);
      if (!input.ok) {
        validationFailure(null, input);
        return;
      }
      await handleResult({ operation: "create", input: input.value });
      return;
    }
    const update = buildUpdateCommand(source, draft, mutationScope);
    if (!update.ok) {
      validationFailure(null, update);
      return;
    }
    await handleResult({ operation: "update", eventId: update.eventId, command: update.command });
  };

  const confirmDelete = async (scope: CalendarMutationScope): Promise<void> => {
    if (!source || busy) return;
    if (resourceScope === null || !calendarCapabilityAllows(capabilities, "delete", resourceScope)) {
      setError(typedError("forbidden", 0, "This calendar action is not permitted."));
      setDeleteOpen(false);
      return;
    }
    const deletion = buildDeleteCommand(source, draft, scope);
    if (!deletion.ok) {
      validationFailure(null, deletion);
      setDeleteOpen(false);
      return;
    }
    await handleResult({ operation: "delete", eventId: deletion.eventId, command: deletion.command });
  };

  const reviewLatest = async (): Promise<void> => {
    if (!source || !sourceId || reviewBusy) return;
    setReviewBusy(true);
    const original = rawSourceTime(originalStartOf(source));
    const options = {
      scope: source.scope,
      ...(original !== undefined ? { originalStart: original } : {}),
    };
    let result: CalendarApiResult<CalendarGetResult> | void;
    try {
      result = onReread
        ? await onReread(sourceId, options)
        : api
          ? await api.get(token, sourceId, options)
          : undefined;
    } catch {
      result = { ok: false, error: { status: 0, code: "api-error" } };
    }
    setReviewBusy(false);
    if (!result) return;
    if (!result.ok) {
      setError(errorFromResult(result.error));
      return;
    }
    setLatestEvent(result.value);
    setError(null);
  };

  const toggleAllDay = (checked: boolean): void => {
    if (checked) {
      setDraftValue({
        allDay: true,
        start: inputDateForToggle(draft.start),
        end: inputDateForToggle(draft.end),
      });
    } else {
      const startDate = inputDateForToggle(draft.start) || todayCalendarDate(new Date(), draft.inputTimeZoneId);
      const endDate = inputDateForToggle(draft.end);
      setDraftValue({
        allDay: false,
        start: timedInputForDate(startDate, 9),
        end: endDate ? timedInputForDate(endDate, 10) : "",
      });
    }
  };

  const recurrenceValue = draft.recurrenceEnabled ? draft.recurrenceFrequency : "none";
  const recurringEdit = mode === "edit" && eventIsRecurring(source);
  const formErrorId = `${formId.current}-error`;
  const conflictId = `${formId.current}-conflict`;
  const hasLatestRevision = latestEvent?.revision !== undefined;

  return (
    <>
      <Dialog
        title={mode === "create" ? "Add to the family calendar" : "Edit calendar event"}
        description={mode === "create" ? "Sentient will check household conflicts before saving." : "Update the supported event details without losing its calendar identity."}
        width={650}
        inertBackground
        safeClose
        onRequestClose={requestClose}
        onClose={closeEditor}
        initialFocusRef={titleRef as { current: HTMLElement | null }}
        footer={
          <div class="calendar-editor__footer-layout">
            {mode === "edit" && (
              <button
                type="button"
                class="app-dialog__btn app-dialog__btn--danger calendar-editor__delete-button"
                onClick={() => setDeleteOpen(true)}
                disabled={!canDelete}
              >
                Delete
              </button>
            )}
            <span class="calendar-editor__footer-spacer" />
            <button type="button" class="app-dialog__btn app-dialog__btn--ghost" onClick={() => requestClose("close-button")} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              form={formId.current}
              class="app-dialog__btn app-dialog__btn--primary"
              disabled={!canSave}
            >
              {busy ? "Saving…" : mode === "create" ? "Add event" : "Save changes"}
            </button>
          </div>
        }
      >
        <form id={formId.current} class="calendar-editor" onSubmit={(e) => void submit(e)}>
          <div class="calendar-editor__field calendar-editor__field--wide">
            <label class="app-dialog__label" for={`${formId.current}-title`}>Event title</label>
            <input
              id={`${formId.current}-title`}
              ref={titleRef}
              class="app-dialog__input"
              type="text"
              value={draft.title}
              maxLength={240}
              required
              aria-describedby={error ? formErrorId : undefined}
              aria-invalid={Boolean(error && (error.code === "validation" || error.code === "invalid_time" || error.code === "invalid_range"))}
              onInput={(e) => setDraftValue({ title: e.currentTarget.value })}
            />
          </div>

          <div class="calendar-editor__field calendar-editor__field--wide">
            <label class="app-dialog__label" for={`${formId.current}-description`}>Description</label>
            <textarea
              id={`${formId.current}-description`}
              class="app-dialog__input calendar-editor__textarea"
              rows={3}
              value={draft.description}
              onInput={(e) => setDraftValue({ description: e.currentTarget.value })}
            />
          </div>

          <div class="calendar-editor__all-day">
            <label class="calendar-editor__check" for={`${formId.current}-all-day`}>
              <input
                id={`${formId.current}-all-day`}
                type="checkbox"
                checked={draft.allDay}
                onChange={(e) => toggleAllDay(e.currentTarget.checked)}
              />
              <span>All day</span>
            </label>
            <span class="calendar-editor__hint">{draft.allDay ? "Date-only event" : `Times use ${draft.inputTimeZoneId}`}</span>
          </div>

          <div class="calendar-editor__date-grid">
            <div class="calendar-editor__field">
              <label class="app-dialog__label" for={`${formId.current}-start`}>{draft.allDay ? "Start date" : "Start"}</label>
              <input
                id={`${formId.current}-start`}
                class="app-dialog__input"
                type={draft.allDay ? "date" : "datetime-local"}
                value={draft.start}
                required
                onInput={(e) => setDraftValue({ start: e.currentTarget.value })}
              />
            </div>
            <div class="calendar-editor__field">
              <label class="app-dialog__label" for={`${formId.current}-end`}>{draft.allDay ? "End date" : "End"}</label>
              <input
                id={`${formId.current}-end`}
                class="app-dialog__input"
                type={draft.allDay ? "date" : "datetime-local"}
                value={draft.end}
                aria-label={draft.allDay ? "End date (optional)" : "End (optional)"}
                onInput={(e) => setDraftValue({ end: e.currentTarget.value })}
              />
            </div>
          </div>

          <div class="calendar-editor__field">
            <label class="app-dialog__label" for={`${formId.current}-scope`}>Calendar</label>
            {mode === "create" ? (
              <select
                id={`${formId.current}-scope`}
                class="app-dialog__input"
                value={draft.scope}
                onChange={(e) => setDraftValue({ scope: e.currentTarget.value as CalendarScope })}
              >
                <option value="private" disabled={!calendarCapabilityAllows(capabilities, saveAction, "private")}>Private</option>
                <option value="household" disabled={!calendarCapabilityAllows(capabilities, saveAction, "household")}>Household</option>
              </select>
            ) : (
              <output id={`${formId.current}-scope`} class="app-dialog__input calendar-editor__readonly" aria-readonly="true">
                {scopeLabel(draft.scope)}
              </output>
            )}
          </div>

          <div class="calendar-editor__field">
            <label class="app-dialog__label" for={`${formId.current}-visibility`}>Visibility</label>
            <select
              id={`${formId.current}-visibility`}
              class="app-dialog__input"
              value={draft.visibility}
              onChange={(e) => setDraftValue({ visibility: e.currentTarget.value as CalendarVisibility })}
            >
              <option value="everyone">Everyone</option>
              <option value="adults">Adults only</option>
            </select>
          </div>

          <div class="calendar-editor__field">
            <label class="app-dialog__label" for={`${formId.current}-importance`}>Importance</label>
            <select
              id={`${formId.current}-importance`}
              class="app-dialog__input"
              value={draft.importance}
              onChange={(e) => setDraftValue({ importance: e.currentTarget.value as CalendarImportance })}
            >
              <option value="normal">Normal</option>
              <option value="important">Important</option>
              <option value="pinned">Pinned</option>
            </select>
          </div>

          <div class="calendar-editor__field">
            <label class="app-dialog__label" for={`${formId.current}-group`}>Group</label>
            <input
              id={`${formId.current}-group`}
              class="app-dialog__input"
              type="text"
              value={draft.group}
              maxLength={80}
              placeholder="Optional group"
              onInput={(e) => setDraftValue({ group: e.currentTarget.value })}
            />
          </div>

          <div class="calendar-editor__field calendar-editor__field--wide">
            <label class="app-dialog__label" for={`${formId.current}-tags`}>Tags</label>
            <input
              id={`${formId.current}-tags`}
              class="app-dialog__input"
              type="text"
              value={draft.tagsText}
              placeholder="family, school"
              aria-describedby={`${formId.current}-tags-hint`}
              onInput={(e) => setDraftValue({ tagsText: e.currentTarget.value })}
            />
            <span id={`${formId.current}-tags-hint`} class="app-dialog__hint">Separate tags with commas.</span>
          </div>

          <div class="calendar-editor__field calendar-editor__field--wide">
            <label class="app-dialog__label" for={`${formId.current}-recurrence`}>Repeat</label>
            <select
              id={`${formId.current}-recurrence`}
              class="app-dialog__input"
              value={recurrenceValue}
              onChange={(e) => {
                const next = e.currentTarget.value;
                if (next === "none") {
                  setDraftValue({ recurrenceEnabled: false });
                } else if (VALID_FREQUENCIES.has(next as CalendarEditorFrequency)) {
                  const frequency = next as CalendarEditorFrequency;
                  setDraftValue({
                    recurrenceEnabled: true,
                    recurrenceFrequency: frequency,
                    ...(frequency === "weekly" ? { recurrenceWeekdays: [weekdaysForStart(draft.start)] } : {}),
                  });
                }
              }}
            >
              <option value="none">Does not repeat</option>
              {FREQUENCIES.map((frequency) => <option value={frequency.value} key={frequency.value}>{frequency.label}</option>)}
            </select>
          </div>

          {draft.recurrenceEnabled && (
            <div class="calendar-editor__recurrence calendar-editor__field--wide">
              <div class="calendar-editor__inline-fields">
                <div class="calendar-editor__field">
                  <label class="app-dialog__label" for={`${formId.current}-recurrence-interval`}>Every</label>
                  <div class="calendar-editor__input-with-suffix">
                    <input
                      id={`${formId.current}-recurrence-interval`}
                      class="app-dialog__input"
                      type="number"
                      min="1"
                      step="1"
                      value={draft.recurrenceInterval}
                      onInput={(e) => setDraftValue({ recurrenceInterval: e.currentTarget.value })}
                    />
                    <span>{draft.recurrenceFrequency === "daily" ? "day(s)" : draft.recurrenceFrequency === "weekly" ? "week(s)" : draft.recurrenceFrequency === "monthly" ? "month(s)" : "year(s)"}</span>
                  </div>
                </div>
              </div>
              {draft.recurrenceFrequency === "weekly" && (
                <fieldset class="calendar-editor__weekdays">
                  <legend class="calendar-editor__legend">On these days</legend>
                  <div class="calendar-editor__weekday-grid">
                    {WEEKDAYS.map((weekday) => {
                      const checked = draft.recurrenceWeekdays.includes(weekday.value);
                      return (
                        <label class="calendar-editor__weekday" for={`${formId.current}-${weekday.value}`} key={weekday.value}>
                          <input
                            id={`${formId.current}-${weekday.value}`}
                            type="checkbox"
                            checked={checked}
                            onChange={() => setDraftValue({
                              recurrenceWeekdays: checked
                                ? draft.recurrenceWeekdays.filter((value) => value !== weekday.value)
                                : [...draft.recurrenceWeekdays, weekday.value],
                            })}
                          />
                          <span>{weekday.label.slice(0, 3)}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              )}
              <div class="calendar-editor__field">
                <label class="app-dialog__label" for={`${formId.current}-recurrence-end`}>Ends</label>
                <select
                  id={`${formId.current}-recurrence-end`}
                  class="app-dialog__input"
                  value={draft.recurrenceEnd}
                  onChange={(e) => setDraftValue({ recurrenceEnd: e.currentTarget.value === "until" ? "until" : "count" })}
                >
                  <option value="count">After a number of occurrences</option>
                  <option value="until">On a date</option>
                </select>
              </div>
              {draft.recurrenceEnd === "count" ? (
                <div class="calendar-editor__field">
                  <label class="app-dialog__label" for={`${formId.current}-recurrence-count`}>Occurrences</label>
                  <input
                    id={`${formId.current}-recurrence-count`}
                    class="app-dialog__input"
                    type="number"
                    min="1"
                    step="1"
                    value={draft.recurrenceCount}
                    onInput={(e) => setDraftValue({ recurrenceCount: e.currentTarget.value })}
                  />
                </div>
              ) : (
                <div class="calendar-editor__field">
                  <label class="app-dialog__label" for={`${formId.current}-recurrence-until`}>Repeat until</label>
                  <input
                    id={`${formId.current}-recurrence-until`}
                    class="app-dialog__input"
                    type={draft.allDay ? "date" : "datetime-local"}
                    value={draft.recurrenceUntil}
                    onInput={(e) => setDraftValue({ recurrenceUntil: e.currentTarget.value })}
                  />
                </div>
              )}
            </div>
          )}

          {recurringEdit && (
            <MutationScopeChooser
              value={mutationScope}
              onChange={(next) => {
                setMutationScope(next);
                setError(null);
              }}
              recurring
              disabled={busy}
              idPrefix={`${formId.current}-mutation-scope`}
              describedBy={conflict ? conflictId : undefined}
            />
          )}

          {error && (
            <div id={formErrorId} class="calendar-editor__error" role="alert" aria-live="polite">
              <p>{error.message}</p>
              {conflict && (
                <div id={conflictId} class="calendar-editor__conflict-actions">
                  <button type="button" class="app-dialog__btn app-dialog__btn--ghost" onClick={() => void reviewLatest()} disabled={reviewBusy}>
                    {reviewBusy ? "Reviewing…" : "Review latest"}
                  </button>
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
        </form>
      </Dialog>

      {deleteOpen && source && (
        <DeleteConfirmation
          title={source.title}
          recurring={eventIsRecurring(source)}
          scope={mutationScope}
          busy={busy}
          error={error?.code === "forbidden" || error?.code === "not_found" || error?.code === "occurrence_not_found" ? error.message : null}
          onScopeChange={setMutationScope}
          onConfirm={(next) => void confirmDelete(next)}
          onCancel={() => {
            if (!busy) setDeleteOpen(false);
          }}
        />
      )}

      {discardOpen && (
        <Dialog
          title="Discard changes?"
          description="Your unsaved calendar draft will be lost."
          width={460}
          inertBackground
          onClose={() => setDiscardOpen(false)}
          footer={
            <>
              <button type="button" class="app-dialog__btn app-dialog__btn--ghost" onClick={() => setDiscardOpen(false)}>
                Keep editing
              </button>
              <button
                type="button"
                class="app-dialog__btn app-dialog__btn--danger"
                onClick={() => {
                  setDiscardOpen(false);
                  closeEditor();
                }}
              >
                Discard draft
              </button>
            </>
          }
        />
      )}
    </>
  );
}

export const CalendarEventEditor = EventEditor;
export const CalendarEditor = EventEditor;
export { DeleteConfirmation } from "./delete-confirmation.tsx";
export { MutationScopeChooser } from "./mutation-scope-chooser.tsx";
export { calendarCapabilityAllows } from "./calendar-access.ts";
export type { CalendarAccessCapabilities } from "./calendar-access.ts";
export {
  buildCreateInput,
  buildDeleteCommand,
  buildUpdateCommand,
};
export const buildCreatePayload = buildCreateInput;
export const buildUpdatePayload = buildUpdateCommand;
export const buildDeletePayload = buildDeleteCommand;
