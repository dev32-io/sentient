import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type {
  CalendarGetResult,
  CalendarMutationScope,
  CalendarApiResult,
} from "../../services/calendar-api.ts";
import { Dialog, type DialogCloseReason } from "../common/dialog.tsx";
import { DeleteConfirmation } from "./delete-confirmation.tsx";
import { calendarCapabilityAllows } from "./calendar-access.ts";
import {
  buildCreateInput,
  buildDeleteCommand,
  buildUpdateCommand,
  editableDraftKey,
  errorFromResult,
  eventIdOf,
  eventIsRecurring,
  eventSource,
  initialDraftFor,
  inputDateForToggle,
  isApiResult,
  originalEventScope,
  originalStartOf,
  rawSourceTime,
  resultOperation,
  typedError,
} from "./calendar-editor-model.ts";
import {
  CalendarEditorBasicsSection,
  CalendarEditorDateTimeSection,
  CalendarEditorFeedback,
  CalendarEditorMetadataSection,
  CalendarEditorRecurrenceSection,
  CalendarEditorScopeSection,
} from "./calendar-editor-sections.tsx";
import { CalendarEditorFooter } from "./calendar-editor-footer.tsx";
import { CalendarDiscardChangesDialog } from "./calendar-editor-overlays.tsx";
import type {
  CalendarEditorApiResult,
  CalendarEditorDraft,
  CalendarEditorError,
  CalendarEditorOutcome,
  CalendarEditorRequest,
  EventEditorProps,
} from "./calendar-editor-types.ts";
import { browserTimeZone, todayCalendarDate } from "./calendar-time.ts";
import "./event-editor.css";

export function EventEditor(props: EventEditorProps): JSX.Element | null {
  const source = eventSource(props.event, props.occurrence);
  const mode = props.mode ?? (source ? "edit" : "create");
  if (props.open === false || (mode === "edit" && !source)) return null;
  // Revision, seed and timezone refreshes are not a new editing target.
  // Closing unmounts the lifetime; reopening takes a fresh snapshot.
  const targetKey = JSON.stringify([
    mode, source?.scope, eventIdOf(source),
    source && "occurrenceId" in source ? source.occurrenceId : rawSourceTime(originalStartOf(source)),
  ]);
  return <EventEditorLifetime key={targetKey} {...props} />;
}

function EventEditorLifetime({
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
  // Keep the source revision paired with the draft: an incidental refresh
  // must not silently authorize overwriting a newer server revision.
  const [source] = useState(() => eventSource(event, occurrence));
  const mode = suppliedMode ?? (source ? "edit" : "create");
  const sourceId = eventIdOf(source);
  const active = useRef(true);
  useLayoutEffect(() => () => { active.current = false; }, []);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const formId = useRef(`calendar-editor-form-${Math.random().toString(36).slice(2, 9)}`);
  const [draft, setDraft] = useState<CalendarEditorDraft>(() => initialDraftFor(source, mode, inputTimeZoneId, initialDraft));
  const baseline = useRef(editableDraftKey(draft));
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
    // A successful mutation clears busy before this approved close path. Keep
    // the force escape hatch so nested confirmation overlays cannot linger.
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
    if (onCreate && request.operation === "create") {
      try {
        const delegated = await onCreate(request.input);
        if (isApiResult(delegated)) return delegated;
        if (!api) return null;
      } catch {
        return { ok: false, error: { status: 0, code: "api-error" } };
      }
    } else if (onUpdate && request.operation === "update") {
      try {
        const delegated = await onUpdate(request.eventId, request.command);
        if (isApiResult(delegated)) return delegated;
        if (!api) return null;
      } catch {
        return { ok: false, error: { status: 0, code: "api-error" } };
      }
    } else if (onDelete && request.operation === "delete") {
      try {
        const delegated = await onDelete(request.eventId, request.command);
        if (isApiResult(delegated)) return delegated;
        if (!api) return null;
      } catch {
        return { ok: false, error: { status: 0, code: "api-error" } };
      }
    } else {
      const callback = onSubmit ?? onCommand;
      if (callback) {
        try {
          const delegated = await callback(request);
          if (isApiResult(delegated)) return delegated;
          if (!api) return null;
        } catch {
          return { ok: false, error: { status: 0, code: "api-error" } };
        }
      }
    }
    if (!active.current || !api) return null;
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
    if (!active.current) return;
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
      ...(successorEventId === undefined ? {} : { successorEventId }),
    };
    onOutcome?.(outcome);
    onSuccess?.(value, request);
    closeEditor(true);
  };

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
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
      ...(original === undefined ? {} : { originalStart: original }),
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
    if (!active.current) return;
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
        start: `${startDate}T09:00`,
        end: endDate ? `${endDate}T10:00` : "",
      });
    }
  };

  const recurringEdit = mode === "edit" && eventIsRecurring(source);
  const formErrorId = `${formId.current}-error`;
  const conflictId = `${formId.current}-conflict`;

  return (
    <>
      <Dialog
        title={mode === "create" ? "Add event" : "Edit event"}
        description={mode === "create" ? "Add the details needed to place this event on the right calendar." : "Update supported event details without changing its calendar identity."}
        width={650}
        inertBackground
        safeClose
        onRequestClose={requestClose}
        onClose={closeEditor}
        initialFocusRef={titleRef as { current: HTMLElement | null }}
        footer={
          <CalendarEditorFooter
            mode={mode}
            formId={formId.current}
            busy={busy}
            canSave={canSave}
            canDelete={canDelete}
            onDelete={() => setDeleteOpen(true)}
            onCancel={() => requestClose("close-button")}
          />
        }
      >
        <form id={formId.current} class="calendar-editor" onSubmit={(event) => void submit(event)}>
          <CalendarEditorBasicsSection draft={draft} formId={formId.current} titleRef={titleRef} onChange={setDraftValue} />
          <CalendarEditorDateTimeSection draft={draft} formId={formId.current} onChange={setDraftValue} onToggleAllDay={toggleAllDay} />
          <CalendarEditorMetadataSection
            draft={draft}
            formId={formId.current}
            mode={mode}
            {...(capabilities === undefined ? {} : { capabilities })}
            onChange={setDraftValue}
          />
          <CalendarEditorRecurrenceSection draft={draft} formId={formId.current} onChange={setDraftValue} />
          {recurringEdit && (
            <CalendarEditorScopeSection
              source={source}
              value={mutationScope}
              conflict={conflict}
              busy={busy}
              formId={formId.current}
              onChange={(next) => {
                setMutationScope(next);
                setError(null);
              }}
            />
          )}
          <CalendarEditorFeedback
            error={error}
            conflict={conflict}
            formErrorId={formErrorId}
            conflictId={conflictId}
            reviewBusy={reviewBusy}
            latestEvent={latestEvent}
            onReviewLatest={() => void reviewLatest()}
          />
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

      <CalendarDiscardChangesDialog
        open={discardOpen}
        onKeepEditing={() => setDiscardOpen(false)}
        onDiscard={() => {
          setDiscardOpen(false);
          closeEditor();
        }}
      />
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
export type {
  CalendarEditorApiResult,
  CalendarEditorCallbackResult,
  CalendarEditorDraft,
  CalendarEditorError,
  CalendarEditorFrequency,
  CalendarEditorInitialDraft,
  CalendarEditorMode,
  CalendarEditorOutcome,
  CalendarEditorRequest,
  EventEditorProps,
} from "./calendar-editor-types.ts";
