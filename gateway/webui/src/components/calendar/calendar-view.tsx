import type { JSX } from "preact";
import { useCallback, useMemo, useRef, useState } from "preact/hooks";
import { useAuth } from "../../hooks/use-auth.tsx";
import {
  type CalendarApi,
  type CalendarCreateInput,
  type CalendarEvent,
  type CalendarMutationCommand,
  type CalendarMutationResult,
  type CalendarOccurrence,
  type CalendarPatch,
  type CalendarTime,
} from "../../services/calendar-api.ts";
import { createCalendarApi } from "../../services/calendar-api.ts";
import { Dialog } from "../common/dialog.tsx";
import { CalendarCanvas } from "./calendar-canvas.tsx";
import {
  EventEditor,
  type CalendarEditorOutcome,
  type CalendarEditorRequest,
} from "./event-editor.tsx";
import { EventPreview } from "./event-preview.tsx";
import {
  CalendarWorkspace,
  type CalendarFilters,
  type CalendarViewMode,
} from "./calendar-shell.tsx";
import {
  calendarCapabilityAllows,
  projectCalendarCapabilities,
  type CalendarAccessCapabilities,
} from "./calendar-access.ts";
import {
  browserLocale,
  browserTimeZone,
  formatAccessibleCalendarDate,
  localeWeekStart,
  todayCalendarDate,
  type CalendarDate,
} from "./calendar-time.ts";
import { projectCalendar } from "./calendar-projections.ts";
import type { CalendarPreferenceStore } from "./calendar-preferences.ts";
import type { CalendarCanvasSlotProps } from "./calendar-canvas-types.ts";
import type { ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";
import { isCalendarPermissionError } from "./calendar-controller.ts";
import { useCalendarController } from "./use-calendar-controller.tsx";
import "./calendar-view.css";

export {
  browserTimeZone,
  calendarTimeFromInput,
  formatCalendarInputValue,
  formatCalendarTime,
  parseCalendarInput,
} from "./calendar-time.ts";

export interface CalendarViewProps {
  api?: CalendarApi;
  token?: string;
  /** Explicit capability projection for embedding and deterministic tests. */
  capabilities?: CalendarAccessCapabilities;
  accountId?: string;
  backendId?: string;
  backendUrl?: string;
  baseUrl?: string;
  preferenceStore?: CalendarPreferenceStore;
  initialView?: CalendarViewMode;
  initialAnchorDate?: string;
  initialDate?: string;
  initialFilters?: Partial<CalendarFilters>;
  now?: () => Date;
  weekStartsOn?: 0 | 1;
}

type PreviewState = {
  readonly occurrence: ProjectedCalendarOccurrence;
  readonly anchor: HTMLElement | null;
};

type EditorState = {
  readonly mode: "create" | "edit";
  readonly event: CalendarOccurrence | null;
};

type OverflowState = {
  readonly date: CalendarDate;
  readonly events: readonly ProjectedCalendarOccurrence[];
};

function defaultBackendIdentity(): string | undefined {
  if (typeof window === "undefined" || typeof window.location?.origin !== "string" || window.location.origin.length === 0) return undefined;
  return window.location.origin;
}

function safeNow(now: (() => Date) | undefined): Date {
  try {
    const value = now?.() ?? new Date();
    return Number.isFinite(value.getTime()) ? value : new Date();
  } catch {
    return new Date();
  }
}

function emptyLabel(view: CalendarViewMode): string {
  switch (view) {
    case "day":
      return "No events on this day.";
    case "week":
      return "No events this week.";
    case "year":
      return "No events this year.";
    default:
      return "No events this month.";
  }
}

function editorEventOf(event: ProjectedCalendarOccurrence): CalendarOccurrence | null {
  const source = event.source;
  // CalendarController consumes CalendarApi's normalized source rows. Keep a
  // runtime check here because the projection seam also accepts raw V2 rows
  // for standalone canvas use.
  if (typeof source.start === "string" || !("occurrenceId" in source)) return null;
  return source as CalendarOccurrence;
}

function isMutationResult(value: unknown): value is CalendarMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "operation" in value && "eventId" in value;
}

function legacyCalendarTime(value: string): CalendarTime {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { kind: "all-day", date: value }
    : { kind: "timed", instant: value };
}

function legacyUpdatePatch(command: Extract<CalendarMutationCommand, { operation: "update" }>): CalendarPatch {
  const changes = command.changes;
  return {
    ...(changes.title === undefined ? {} : { title: changes.title }),
    ...(changes.description === undefined ? {} : { description: changes.description }),
    ...(changes.start === undefined ? {} : { start: legacyCalendarTime(changes.start) }),
    ...(changes.end === undefined || changes.end === null ? { ...(changes.end === null ? { end: null } : {}) } : { end: legacyCalendarTime(changes.end) }),
    ...(changes.visibility === undefined ? {} : { visibility: changes.visibility }),
    ...(changes.importance === undefined ? {} : { importance: changes.importance }),
    ...(changes.group === undefined ? {} : { group: changes.group }),
    ...(changes.tags === undefined ? {} : { tags: changes.tags }),
    ...(changes.recurrence === undefined ? {} : { recurrence: changes.recurrence }),
    ...(command.scope === undefined ? {} : { scope: command.scope }),
    ...(command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision }),
  };
}

function permissionState(reason: "signin" | "calendar"): JSX.Element {
  return (
    <section class="calendar-route-state calendar-route-state--permission" data-calendar-permission-state={reason} aria-labelledby="calendar-permission-title">
      <div class="calendar-route-state__card">
        <p class="calendar-route-state__eyebrow">Calendar</p>
        <h1 id="calendar-permission-title">{reason === "signin" ? "Sign in to view Calendar" : "Calendar access unavailable"}</h1>
        <p>{reason === "signin" ? "Authenticate to see the calendars available to your account." : "This account cannot view the calendar right now."}</p>
      </div>
    </section>
  );
}

function loadingState(): JSX.Element {
  return (
    <section class="calendar-route-state" data-calendar-route-loading aria-busy="true" aria-labelledby="calendar-loading-title">
      <div class="calendar-route-state__card" role="status">
        <p class="calendar-route-state__eyebrow">Calendar</p>
        <h1 id="calendar-loading-title">Loading calendar</h1>
        <p>Preparing your authorized calendar view.</p>
      </div>
    </section>
  );
}

function CalendarRouteNotice({
  errorCode,
  hasData,
  refreshing,
  stale,
  canEdit,
  mutationNotice,
  successorEventId,
  onRetry,
}: {
  readonly errorCode: string | null;
  readonly hasData: boolean;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly canEdit: boolean;
  readonly mutationNotice: string | null;
  readonly successorEventId: string | null;
  readonly onRetry: () => void;
}): JSX.Element | null {
  const notices: JSX.Element[] = [];
  if (errorCode && hasData) {
    notices.push(
      <div class="calendar-route-notice calendar-route-notice--stale" role="status" key="stale" data-calendar-state="stale">
        <span>Showing the last saved calendar data.</span>
        <button type="button" onClick={onRetry}>Try again</button>
      </div>,
    );
  } else if (stale) {
    notices.push(
      <div class="calendar-route-notice calendar-route-notice--stale" role="status" key="stale-refreshing" data-calendar-state="stale">
        <span>Showing saved events while Calendar refreshes.</span>
      </div>,
    );
  } else if (refreshing) {
    notices.push(
      <div class="calendar-route-notice" role="status" key="refreshing" data-calendar-state="refreshing">
        Refreshing Calendar…
      </div>,
    );
  }
  if (!hasData && errorCode && errorCode !== "forbidden") {
    notices.push(
      <div class="calendar-route-notice calendar-route-notice--error" role="alert" key="error" data-calendar-state="error">
        <span>Calendar could not be loaded.</span>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>,
    );
  }
  if (!canEdit) {
    notices.push(
      <div class="calendar-route-notice calendar-route-notice--permission" role="status" key="permission" data-calendar-state="permission">
        Calendar editing is unavailable for this session.
      </div>,
    );
  }
  if (mutationNotice) {
    notices.push(
      <div
        class="calendar-route-notice calendar-route-notice--success"
        role="status"
        key="mutation"
        data-calendar-state="mutation-success"
        {...(successorEventId === null ? {} : { "data-successor-event-id": successorEventId })}
      >
        {mutationNotice}
      </div>,
    );
  }
  if (notices.length === 0) return null;
  return <div class="calendar-route-notices" aria-live="polite">{notices}</div>;
}

function CalendarOverflowDialog({
  state,
  onClose,
  onOpen,
}: {
  readonly state: OverflowState;
  readonly onClose: () => void;
  readonly onOpen: (event: ProjectedCalendarOccurrence, anchor: HTMLElement) => void;
}): JSX.Element {
  return (
    <Dialog
      title={`Events on ${formatAccessibleCalendarDate(state.date)}`}
      description="Every event in this dense day remains available to open."
      width={460}
      inertBackground
      onClose={onClose}
      footer={<button type="button" class="app-dialog__btn app-dialog__btn--ghost" onClick={onClose}>Close</button>}
    >
      <div class="calendar-overflow-dialog__list" role="list" aria-label="Events in this day">
        {state.events.map((event) => (
          <div role="listitem" key={event.occurrenceId}>
            <button
              type="button"
              class="calendar-overflow-dialog__event"
              onClick={(e) => onOpen(event, e.currentTarget)}
            >
              <strong>{event.title}</strong>
              <span>{event.start.label}</span>
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function CalendarView({
  api,
  token: suppliedToken,
  capabilities: suppliedCapabilities,
  accountId,
  backendId,
  backendUrl,
  baseUrl,
  preferenceStore,
  initialView,
  initialAnchorDate,
  initialDate,
  initialFilters,
  now,
  weekStartsOn: suppliedWeekStartsOn,
}: CalendarViewProps = {}): JSX.Element {
  const auth = useAuth();
  const apiBaseUrl = baseUrl ?? backendUrl;
  const stableApi = useMemo(() => api ?? createCalendarApi({ ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }) }), [api, apiBaseUrl]);
  const authenticatedUser = auth.status === "authenticated" ? auth.user : undefined;
  const token = suppliedToken ?? (auth.status === "authenticated" ? auth.token : "");
  const capabilities = suppliedCapabilities ?? projectCalendarCapabilities(authenticatedUser);
  const canCreatePrivate = calendarCapabilityAllows(capabilities, "create", "private");
  const canCreateHousehold = calendarCapabilityAllows(capabilities, "create", "household");
  const canCreate = canCreatePrivate || canCreateHousehold;
  const canEdit = calendarCapabilityAllows(capabilities, "update", "private") || calendarCapabilityAllows(capabilities, "update", "household");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [overflow, setOverflow] = useState<OverflowState | null>(null);
  const overflowOriginRef = useRef<HTMLElement | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [successorEventId, setSuccessorEventId] = useState<string | null>(null);

  const openAddEvent = useCallback((): void => {
    if (!canCreate) return;
    setMutationNotice(null);
    setSuccessorEventId(null);
    setPreview(null);
    setOverflow(null);
    setEditor({ mode: "create", event: null });
  }, [canCreate]);

  const sessionAccountId = accountId ?? authenticatedUser?.userId;
  const sessionBackendId = backendId ?? backendUrl ?? baseUrl ?? defaultBackendIdentity();
  const controller = useCalendarController({
    api: stableApi,
    token,
    ...(sessionAccountId === undefined ? {} : { accountId: sessionAccountId }),
    ...(sessionBackendId === undefined ? {} : { backendId: sessionBackendId }),
    ...(backendUrl === undefined ? {} : { backendUrl }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(preferenceStore === undefined ? {} : { preferenceStore }),
    ...(initialView === undefined ? {} : { initialView }),
    ...(initialAnchorDate === undefined ? {} : { initialAnchorDate }),
    ...(initialDate === undefined ? {} : { initialDate }),
    ...(initialFilters === undefined ? {} : { initialFilters }),
    ...(now === undefined ? {} : { now }),
    ...(suppliedWeekStartsOn === undefined ? {} : { weekStartsOn: suppliedWeekStartsOn }),
    onAddEvent: openAddEvent,
  });

  const locale = browserLocale();
  const timeZone = browserTimeZone();
  const weekStartsOn = suppliedWeekStartsOn ?? (localeWeekStart(locale) === 0 ? 0 : 1);
  const today = todayCalendarDate(safeNow(now), timeZone);
  const permissionDenied = isCalendarPermissionError(controller.error);
  const renderedOccurrences = permissionDenied ? [] : controller.filteredOccurrences;
  const richProjection = useMemo<CalendarCanvasSlotProps["projection"]>(() => {
    if (controller.dataInterval === null || permissionDenied) return null;
    try {
      return projectCalendar({
        occurrences: renderedOccurrences,
        view: controller.view,
        anchorDate: controller.anchorDate as CalendarDate,
        selectedDate: controller.selectedDate as CalendarDate,
        locale,
        timeZone,
        deviceTimeZone: timeZone,
        weekStartsOn,
        today,
        density: { maxVisibleEvents: 3, maxIndicators: 3 },
      }).view;
    } catch {
      // A malformed source row must not take down the route. The controller
      // remains the source of truth and its safe error surface is shown below.
      return null;
    }
  }, [controller.anchorDate, controller.dataInterval, permissionDenied, renderedOccurrences, controller.selectedDate, controller.view, locale, timeZone, today, weekStartsOn]);

  const openPreview = useCallback((occurrence: ProjectedCalendarOccurrence, anchor: HTMLElement | null = null): void => {
    setPreview({ occurrence, anchor });
    setOverflow(null);
  }, []);

  const openEditorFor = useCallback((occurrence: ProjectedCalendarOccurrence): void => {
    const event = editorEventOf(occurrence);
    if (!event) return;
    setPreview(null);
    setOverflow(null);
    setMutationNotice(null);
    setSuccessorEventId(null);
    setEditor({ mode: "edit", event });
  }, []);

  const onOpenEvent = useCallback((occurrence: ProjectedCalendarOccurrence): void => {
    overflowOriginRef.current = null;
    const active = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    openPreview(occurrence, active);
  }, [openPreview]);

  const onOpenOverflow = useCallback((date: CalendarDate, events: readonly ProjectedCalendarOccurrence[]): void => {
    const active = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // The dialog's event buttons are transient. Retain the mounted +N trigger
    // (or the first deterministic overflow control in jsdom) as the stable
    // preview origin before the dialog is unmounted.
    overflowOriginRef.current = active?.matches("[data-calendar-overflow='true']")
      ? active
      : document.querySelector<HTMLElement>("[data-calendar-overflow='true']");
    setPreview(null);
    setOverflow({ date, events });
  }, []);

  const onOpenOverflowEvent = useCallback((occurrence: ProjectedCalendarOccurrence, anchor: HTMLElement): void => {
    const stableOrigin = overflowOriginRef.current?.isConnected
      ? overflowOriginRef.current
      : anchor.isConnected
        ? anchor
        : document.querySelector<HTMLElement>("[data-calendar-floating-view-bar] button");
    openPreview(occurrence, stableOrigin);
  }, [openPreview]);

  const onCreate = useCallback((input: CalendarCreateInput) => stableApi.create(token, input), [stableApi, token]);

  const onUpdate = useCallback((eventId: string, command: Extract<CalendarMutationCommand, { operation: "update" }>) => {
    if (typeof stableApi.mutate === "function") return stableApi.mutate(token, eventId, command);
    // Legacy test doubles may only implement update. Production V2 always uses
    // mutate, so this branch never weakens the wire contract.
    return stableApi.update(token, eventId, legacyUpdatePatch(command));
  }, [stableApi, token]);

  const onDelete = useCallback((eventId: string, command: Extract<CalendarMutationCommand, { operation: "delete" }>) => {
    if (typeof stableApi.mutate === "function") return stableApi.mutate(token, eventId, command);
    return stableApi.delete(token, eventId, command.expectedRevision);
  }, [stableApi, token]);

  const onMutationSuccess = useCallback((result: CalendarApiResultValue, request: CalendarEditorRequest): void => {
    const mutation = isMutationResult(result) ? result : null;
    const successor = mutation?.successorEventId ?? null;
    setSuccessorEventId(successor);
    setMutationNotice(request.operation === "delete" ? "Event deleted." : request.operation === "create" ? "Event added." : "Event saved.");
    // CalendarController retains the last complete set while this refresh runs,
    // so a successful mutation never flashes an empty canvas.
    void controller.actions.refresh();
  }, [controller.actions,]);

  const onEditorOutcome = useCallback((outcome: CalendarEditorOutcome): void => {
    if (outcome.kind === "failure") {
      setMutationNotice(null);
      setSuccessorEventId(null);
    }
  }, []);

  const closeEditor = useCallback((): void => {
    setEditor(null);
  }, []);

  const stateHasData = controller.dataInterval !== null;
  const errorCode = controller.error?.code ?? null;
  const authIsPending = auth.status === "boot" || auth.status === "authenticating";
  if (authIsPending && !suppliedToken) return loadingState();
  if (!token) return permissionState("signin");
  if (permissionDenied) return permissionState("calendar");

  const previewEdit = preview && calendarCapabilityAllows(capabilities, "update", preview.occurrence.scope)
    ? openEditorFor
    : undefined;
  const previewDelete = preview && calendarCapabilityAllows(capabilities, "delete", preview.occurrence.scope)
    ? openEditorFor
    : undefined;

  return (
    <section class="calendar-view" data-calendar-route aria-labelledby="calendar-period-title">
      <CalendarRouteNotice
        errorCode={errorCode}
        hasData={stateHasData}
        refreshing={controller.refreshing}
        stale={controller.stale}
        canEdit={canEdit}
        mutationNotice={mutationNotice}
        successorEventId={successorEventId}
        onRetry={() => void controller.actions.refresh()}
      />
      <CalendarWorkspace
        view={controller.view}
        selectedView={controller.selectedView}
        anchorDate={controller.anchorDate}
        selectedDate={controller.selectedDate}
        weekStartsOn={weekStartsOn}
        locale={locale}
        filters={controller.filters}
        facets={controller.facets}
        projection={richProjection as CalendarCanvasSlotProps["projection"]}
        resultCount={controller.filteredOccurrences.length}
        liveAnnouncement={controller.liveAnnouncement}
        loading={controller.loading}
        refreshing={controller.refreshing}
        emptyLabel={emptyLabel(controller.view)}
        addEventDisabled={!canCreate}
        onFiltersChange={controller.actions.setFilters}
        onViewChange={(view) => void controller.actions.setView(view)}
        onPrevious={() => void controller.actions.previous()}
        onNext={() => void controller.actions.next()}
        onToday={() => void controller.actions.goToToday()}
        onDateChange={(date) => void controller.actions.setAnchorDate(date)}
        onSelectDate={(date) => void controller.actions.selectDate(date)}
        onSelectMonth={(year, month) => void controller.actions.selectMonth(year, month)}
        onOpenEvent={onOpenEvent}
        onOpenOverflow={onOpenOverflow}
        onAddEvent={controller.actions.openAddEvent}
      >
        <CalendarCanvas />
      </CalendarWorkspace>

      {preview && (
        <EventPreview
          occurrence={preview.occurrence}
          anchor={preview.anchor}
          viewportMargin={12}
          deviceTimeZone={timeZone}
          onClose={() => setPreview(null)}
          {...(previewEdit === undefined ? {} : { onEdit: previewEdit })}
          {...(previewDelete === undefined ? {} : { onDelete: previewDelete })}
        />
      )}

      {overflow && (
        <CalendarOverflowDialog
          state={overflow}
          onClose={() => setOverflow(null)}
          onOpen={onOpenOverflowEvent}
        />
      )}

      {editor && (
        <EventEditor
          open
          mode={editor.mode}
          event={editor.event}
          api={stableApi}
          token={token}
          {...(capabilities === undefined ? {} : { capabilities })}
          {...(editor.mode === "create" ? { initialDraft: { scope: canCreatePrivate ? "private" : "household" } } : {})}
          inputTimeZoneId={timeZone}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onOutcome={onEditorOutcome}
          onSuccess={(result, request) => onMutationSuccess(result, request)}
          onClose={closeEditor}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
        />
      )}
    </section>
  );
}

type CalendarApiResultValue = CalendarEvent | CalendarMutationResult;

export type { CalendarAccessCapabilities } from "./calendar-access.ts";