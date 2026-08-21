import type {
  CalendarApi,
  CalendarErrorCode,
  CalendarListOptions,
  CalendarOccurrence,
} from "../../services/calendar-api.ts";
import {
  calendarPreferenceNamespace,
  createCalendarPreferenceStore,
  defaultCalendarPreferences,
  isCalendarDate,
  type CalendarPreferenceStore,
  type CalendarPreferences,
  type CalendarViewMode,
  validateCalendarPreferences,
} from "./calendar-preferences.ts";
import {
  calendarIntervalFor,
  deriveCalendarFacets,
  filterCalendarOccurrences,
  projectCalendarInterval,
  stepCalendarAnchor,
  type CalendarFacets,
  type CalendarFilters,
  type CalendarInterval,
  type CalendarViewProjection,
} from "./calendar-projections.ts";

export type { CalendarFilters, CalendarInterval, CalendarViewMode } from "./calendar-projections.ts";

export type CalendarControllerErrorCode =
  | CalendarErrorCode
  | "cursor-loop"
  | "invalid-page"
  | "pagination-limit"
  | "cancelled"
  | "request-failed"
  | "api-error";

export interface CalendarControllerError {
  /** A bounded structural code; server reason/message text is intentionally omitted. */
  readonly code: string;
  readonly kind: string;
  readonly status: number;
  readonly message: string;
}

export type CalendarLoadPhase = "idle" | "loading" | "refreshing" | "ready" | "error";
export type CalendarFreshness = "idle" | "loading" | "refreshing" | "fresh" | "stale" | "error";

export interface CalendarLoadStatus {
  readonly phase: CalendarLoadPhase;
  readonly freshness: CalendarFreshness;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isStale: boolean;
  readonly isFresh: boolean;
  readonly error: CalendarControllerError | null;
}

export interface CalendarProjectionDelegates {
  readonly filterCalendarOccurrences: (
    occurrences: readonly CalendarOccurrence[],
    filters: CalendarFilters,
  ) => readonly CalendarOccurrence[];
  readonly deriveCalendarFacets: (
    occurrences: readonly CalendarOccurrence[],
    filters: CalendarFilters,
  ) => CalendarFacets;
  readonly projectCalendarInterval: (
    view: CalendarViewMode,
    interval: CalendarInterval,
    occurrences: readonly CalendarOccurrence[],
    filteredOccurrences: readonly CalendarOccurrence[],
  ) => CalendarViewProjection;
}

export interface CalendarControllerOptions {
  readonly api: CalendarApi;
  readonly token: string;
  /** Authenticated account identity. `userId` is accepted as a source-compatible alias. */
  readonly accountId?: string;
  readonly userId?: string;
  /** Stable backend identity, not a bearer token. */
  readonly backendId?: string;
  readonly backendUrl?: string;
  readonly baseUrl?: string;
  readonly preferenceStore?: CalendarPreferenceStore;
  readonly initialView?: CalendarViewMode;
  readonly initialAnchorDate?: string;
  readonly initialDate?: string;
  readonly initialFilters?: Partial<CalendarFilters>;
  readonly now?: () => Date;
  readonly weekStartsOn?: 0 | 1;
  readonly projections?: Partial<CalendarProjectionDelegates>;
  readonly onAddEvent?: () => void;
}

export interface CalendarControllerActions {
  readonly setView: (view: CalendarViewMode) => Promise<void>;
  readonly setSelectedView: (view: CalendarViewMode) => Promise<void>;
  readonly setAnchorDate: (date: string) => Promise<void>;
  readonly setSelectedDate: (date: string) => Promise<void>;
  readonly selectDate: (date: string) => Promise<void>;
  readonly goToToday: () => Promise<void>;
  readonly previous: () => Promise<void>;
  readonly next: () => Promise<void>;
  readonly setFilters: (filters: Partial<CalendarFilters> | CalendarFilters) => void;
  readonly setSelectedFilters: (filters: Partial<CalendarFilters> | CalendarFilters) => void;
  readonly refresh: () => Promise<void>;
  readonly openAddEvent: () => void;
}

export interface CalendarControllerSnapshot {
  readonly anchorDate: string;
  readonly selectedDate: string;
  readonly selectedView: CalendarViewMode;
  readonly view: CalendarViewMode;
  readonly visibleInterval: CalendarInterval;
  /** Complete, unfiltered, authorized data for the last successfully loaded interval. */
  readonly completeOccurrences: readonly CalendarOccurrence[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly events: readonly CalendarOccurrence[];
  /** The interval represented by completeOccurrences; it can differ while a refresh is pending. */
  readonly dataInterval: CalendarInterval | null;
  readonly selectedFilters: CalendarFilters;
  readonly filters: CalendarFilters;
  readonly filteredOccurrences: readonly CalendarOccurrence[];
  readonly visibleOccurrences: readonly CalendarOccurrence[];
  readonly facets: CalendarFacets;
  readonly facetOptions: CalendarFacets;
  readonly derivedFacets: CalendarFacets;
  readonly projection: CalendarViewProjection;
  readonly projections: CalendarViewProjection;
  readonly status: CalendarLoadPhase;
  readonly freshness: CalendarFreshness;
  readonly loadStatus: CalendarLoadStatus;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly fresh: boolean;
  readonly error: CalendarControllerError | null;
  /** Safe count/view-only text for aria-live; it never contains event or query text. */
  readonly liveAnnouncement: string;
  readonly resultAnnouncement: string;
  readonly announcement: string;
  /** Editor draft state is intentionally not part of this controller. */
  readonly openAddEvent: () => void;
  readonly addEventOpener: () => void;
  readonly onAddEvent: () => void;
}

export type CalendarControllerListener = (state: CalendarControllerSnapshot) => void;

export interface CalendarPageAggregationOptions {
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
}

export type CalendarPageAggregationResult =
  | { readonly ok: true; readonly value: readonly CalendarOccurrence[] }
  | { readonly ok: false; readonly error: CalendarControllerError };

const DEFAULT_MAX_PAGES = 10_000;
const SAFE_CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const KNOWN_ERROR_CODES = new Set([
  "invalid_time",
  "invalid_range",
  "range_too_wide",
  "invalid_scope",
  "invalid_mutation_scope",
  "forbidden",
  "not_found",
  "occurrence_not_found",
  "result_too_large",
  "recurrence_conflict",
  "conflict",
  "aborted",
  "io_error",
  "missing_token",
  "malformed",
  "expired",
  "signature_invalid",
  "wrong_purpose",
  "user_not_found",
  "invalid_user_record",
  "invalid-json",
  "network-error",
  "cursor-loop",
  "invalid-page",
  "pagination-limit",
  "cancelled",
  "request-failed",
  "api-error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function safeToday(now: () => Date): string {
  try {
    const value = now();
    if (!Number.isFinite(value.getTime())) return "1970-01-01";
    return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  } catch {
    return "1970-01-01";
  }
}

function timeValue(value: unknown): number {
  if (!isRecord(value)) return Number.POSITIVE_INFINITY;
  if (value.kind === "all-day" && typeof value.date === "string") {
    const result = Date.parse(`${value.date}T00:00:00.000Z`);
    return Number.isFinite(result) ? result : Number.POSITIVE_INFINITY;
  }
  if (value.kind === "timed" && typeof value.instant === "string") {
    const result = Date.parse(value.instant);
    return Number.isFinite(result) ? result : Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

function occurrenceKey(event: CalendarOccurrence): string {
  if (typeof event.occurrenceId === "string" && event.occurrenceId.length > 0) return event.occurrenceId;
  const eventId = event.eventId ?? event.baseEventId ?? event.id ?? "unknown-event";
  const original = event.originalStart ?? event.occurrenceStart ?? event.start;
  const value = isRecord(original)
    ? original.kind === "all-day" ? original.date : original.instant
    : "unknown-start";
  return `${eventId}:${String(value)}`;
}

function compareOccurrences(a: CalendarOccurrence, b: CalendarOccurrence): number {
  const start = timeValue(a.start) - timeValue(b.start);
  if (start !== 0) return start;
  const scope = String(a.scope ?? "").localeCompare(String(b.scope ?? ""));
  if (scope !== 0) return scope;
  const eventId = (a.eventId ?? a.baseEventId ?? a.id ?? "").localeCompare(b.eventId ?? b.baseEventId ?? b.id ?? "");
  if (eventId !== 0) return eventId;
  return occurrenceKey(a).localeCompare(occurrenceKey(b));
}

function normalizedCode(value: unknown): string {
  if (typeof value !== "string") return "api-error";
  const code = value.trim().toLocaleLowerCase();
  return SAFE_CODE.test(code) && KNOWN_ERROR_CODES.has(code) ? code : "api-error";
}

function messageFor(code: string): string {
  switch (code) {
    case "cursor-loop": return "Calendar pagination could not complete.";
    case "invalid-page": return "Calendar returned an invalid page.";
    case "pagination-limit": return "Calendar pagination could not complete.";
    case "cancelled": return "Calendar refresh was cancelled.";
    case "request-failed": return "Calendar could not be loaded.";
    default: return "Calendar could not be loaded.";
  }
}

function controllerError(code: string, status = 0): CalendarControllerError {
  const safe = normalizedCode(code);
  return { code: safe, kind: safe, status: Number.isFinite(status) && status >= 0 ? status : 0, message: messageFor(safe) };
}

function apiError(error: unknown): CalendarControllerError {
  if (!isRecord(error)) return controllerError("api-error");
  const status = typeof error.status === "number" ? error.status : 0;
  return controllerError(typeof error.code === "string" ? error.code : "api-error", status);
}

function cancelled(): CalendarPageAggregationResult {
  return { ok: false, error: controllerError("cancelled") };
}

function validPage(value: unknown): value is { events: CalendarOccurrence[]; nextCursor?: string } {
  if (!isRecord(value) || !Array.isArray(value.events)) return false;
  if (value.nextCursor !== undefined && (typeof value.nextCursor !== "string" || value.nextCursor.length === 0)) return false;
  return true;
}

/**
 * Traverse every REST page for one interval. The API is always queried with
 * scope=all; local filters are deliberately not sent over this boundary.
 */
export async function loadCompleteCalendarInterval(
  api: CalendarApi,
  token: string,
  interval: CalendarInterval,
  options: CalendarPageAggregationOptions = {},
): Promise<CalendarPageAggregationResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const seenCursors = new Set<string>();
  const seenOccurrences = new Set<string>();
  const aggregate: CalendarOccurrence[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (true) {
    if (options.signal?.aborted) return cancelled();
    if (pages >= maxPages) return { ok: false, error: controllerError("pagination-limit") };
    pages += 1;
    const request: CalendarListOptions = {
      from: interval.from,
      to: interval.to,
      scope: "all",
      ...(cursor !== undefined ? { cursor } : {}),
    };
    let result: Awaited<ReturnType<CalendarApi["list"]>>;
    try {
      result = await api.list(token, request);
    } catch {
      if (options.signal?.aborted) return cancelled();
      return { ok: false, error: controllerError("request-failed") };
    }
    if (options.signal?.aborted) return cancelled();
    if (!result.ok) return { ok: false, error: apiError(result.error) };
    if (!validPage(result.value)) return { ok: false, error: controllerError("invalid-page") };

    for (const event of result.value.events) {
      if (!event || typeof event !== "object" || typeof event.occurrenceId !== "string" || event.occurrenceId.length === 0) {
        return { ok: false, error: controllerError("invalid-page") };
      }
      const key = occurrenceKey(event);
      if (seenOccurrences.has(key)) continue;
      seenOccurrences.add(key);
      aggregate.push(event);
    }

    const nextCursor = result.value.nextCursor;
    if (nextCursor === undefined) {
      aggregate.sort(compareOccurrences);
      return { ok: true, value: aggregate };
    }
    if (seenCursors.has(nextCursor) || nextCursor === cursor) {
      return { ok: false, error: controllerError("cursor-loop") };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export const aggregateCalendarPages = loadCompleteCalendarInterval;
export const fetchCompleteCalendarOccurrences = loadCompleteCalendarInterval;

function filtersFromPreferences(preferences: CalendarPreferences): CalendarFilters {
  return {
    scopes: [...preferences.scopes],
    groups: [...preferences.groups],
    tags: [...preferences.tags],
    importance: preferences.importance,
    search: preferences.search,
  };
}

function safeFilters(
  fallback: CalendarPreferences,
  value: Partial<CalendarFilters> | undefined,
): CalendarPreferences {
  if (!value) return fallback;
  return validateCalendarPreferences({ ...fallback, ...value }, fallback);
}

function intervalKey(interval: CalendarInterval): string {
  return `${interval.from}\u0000${interval.to}`;
}

function viewLabel(view: CalendarViewMode): string {
  return view.charAt(0).toUpperCase() + view.slice(1);
}

function initialBackendId(options: CalendarControllerOptions): string {
  if (options.backendId?.trim()) return options.backendId.trim();
  if (options.backendUrl?.trim()) return options.backendUrl.trim();
  if (options.baseUrl?.trim()) return options.baseUrl.trim();
  try {
    if (typeof globalThis.location !== "undefined" && globalThis.location.origin) return globalThis.location.origin;
  } catch {
    // Non-browser consumers can supply an explicit backend identity.
  }
  return "default-backend";
}

function initialAccountId(options: CalendarControllerOptions): string {
  return options.accountId?.trim() || options.userId?.trim() || "";
}

interface InFlightLoad {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

/**
 * Stateful, transport-injected web calendar controller. It owns only server
 * data, view/filter preferences, and intents; editor drafts remain with the
 * editor task.
 */
export class CalendarController {
  private api: CalendarApi;
  private token: string;
  private accountId: string;
  private backendId: string;
  private namespace: string | null;
  private readonly preferenceStore: CalendarPreferenceStore;
  private readonly now: () => Date;
  private readonly weekStartsOn: 0 | 1;
  private readonly projectionFunctions: CalendarProjectionDelegates;
  private addEventCallback: (() => void) | undefined;
  private preferences: CalendarPreferences;
  private completeOccurrences: readonly CalendarOccurrence[] = [];
  private completeInterval: CalendarInterval | null = null;
  private hasCompleteData = false;
  private phase: CalendarLoadPhase;
  private errorState: CalendarControllerError | null = null;
  private readonly listeners = new Set<CalendarControllerListener>();
  private readonly requests = new Map<string, InFlightLoad>();
  private activeKey: string | null = null;
  private disposed = false;
  private sessionGeneration = 0;
  private preferenceHydrated = false;
  private pendingPreferenceRead: Promise<unknown> | null = null;
  private readonly actionsValue: CalendarControllerActions;
  private stateValue: CalendarControllerSnapshot;
  private readyPromise: Promise<void>;

  public constructor(options: CalendarControllerOptions) {
    this.api = options.api;
    this.token = options.token;
    this.accountId = initialAccountId(options);
    this.backendId = initialBackendId(options);
    this.namespace = calendarPreferenceNamespace({ accountId: this.accountId, backendId: this.backendId });
    this.preferenceStore = options.preferenceStore ?? createCalendarPreferenceStore();
    this.now = options.now ?? (() => new Date());
    this.weekStartsOn = options.weekStartsOn ?? 1;
    this.addEventCallback = options.onAddEvent;

    const today = safeToday(this.now);
    const fallback = defaultCalendarPreferences(options.initialAnchorDate ?? options.initialDate ?? today);
    this.preferences = validateCalendarPreferences({
      ...fallback,
      ...(options.initialView !== undefined ? { view: options.initialView } : {}),
      ...(options.initialAnchorDate !== undefined ? { anchorDate: options.initialAnchorDate } : {}),
      ...(options.initialDate !== undefined ? { selectedDate: options.initialDate, anchorDate: options.initialDate } : {}),
      ...(options.initialFilters ?? {}),
    }, fallback);
    this.preparePreferenceRead();
    this.phase = this.token ? "loading" : "idle";
    this.projectionFunctions = {
      filterCalendarOccurrences,
      deriveCalendarFacets,
      projectCalendarInterval,
      ...options.projections,
    };
    this.actionsValue = {
      setView: (view) => this.setView(view),
      setSelectedView: (view) => this.setView(view),
      setAnchorDate: (date) => this.setAnchorDate(date),
      setSelectedDate: (date) => this.setSelectedDate(date),
      selectDate: (date) => this.setSelectedDate(date),
      goToToday: () => this.goToToday(),
      previous: () => this.previous(),
      next: () => this.next(),
      setFilters: (filters) => this.setFilters(filters),
      setSelectedFilters: (filters) => this.setFilters(filters),
      refresh: () => this.refresh(),
      openAddEvent: () => this.openAddEvent(),
    };
    this.stateValue = this.buildState();
    this.readyPromise = this.initialize();
  }

  public get state(): CalendarControllerSnapshot {
    return this.stateValue;
  }

  public getState(): CalendarControllerSnapshot {
    return this.stateValue;
  }

  public get actions(): CalendarControllerActions {
    return this.actionsValue;
  }

  public get ready(): Promise<void> {
    return this.readyPromise;
  }

  public whenReady(): Promise<void> {
    return this.readyPromise;
  }

  public get preferenceNamespace(): string | null {
    return this.namespace;
  }

  public subscribe(listener: CalendarControllerListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  public setAddEventOpener(callback: (() => void) | undefined): void {
    this.addEventCallback = callback;
  }

  public openAddEvent(): void {
    if (this.disposed) return;
    this.addEventCallback?.();
  }

  public setView(view: CalendarViewMode): Promise<void> {
    if (this.disposed || this.preferences.view === view) return Promise.resolve();
    this.preferences = validateCalendarPreferences({ ...this.preferences, view }, this.preferences);
    this.persistPreferences();
    this.emit();
    return this.refresh();
  }

  public setAnchorDate(date: string): Promise<void> {
    if (this.disposed || !isCalendarDate(date) || this.preferences.anchorDate === date) return Promise.resolve();
    this.preferences = validateCalendarPreferences({ ...this.preferences, anchorDate: date }, this.preferences);
    this.persistPreferences();
    this.emit();
    return this.refresh();
  }

  public setSelectedDate(date: string): Promise<void> {
    if (this.disposed || !isCalendarDate(date) || this.preferences.selectedDate === date) return Promise.resolve();
    this.preferences = validateCalendarPreferences({ ...this.preferences, selectedDate: date }, this.preferences);
    this.persistPreferences();
    this.emit();
    return Promise.resolve();
  }

  public goToToday(): Promise<void> {
    return this.setCalendarDates(safeToday(this.now));
  }

  public previous(): Promise<void> {
    const date = stepCalendarAnchor(this.preferences.view, this.preferences.anchorDate, -1);
    return this.setCalendarDates(date);
  }

  public next(): Promise<void> {
    const date = stepCalendarAnchor(this.preferences.view, this.preferences.anchorDate, 1);
    return this.setCalendarDates(date);
  }

  private setCalendarDates(date: string): Promise<void> {
    if (this.disposed || !isCalendarDate(date)) return Promise.resolve();
    if (this.preferences.anchorDate === date && this.preferences.selectedDate === date) return Promise.resolve();
    this.preferences = validateCalendarPreferences({ ...this.preferences, anchorDate: date, selectedDate: date }, this.preferences);
    this.persistPreferences();
    this.emit();
    return this.refresh();
  }

  public setFilters(value: Partial<CalendarFilters> | CalendarFilters): void {
    if (this.disposed) return;
    this.preferences = safeFilters(this.preferences, value);
    this.persistPreferences();
    this.emit();
  }

  public async refresh(): Promise<void> {
    if (this.disposed || !this.token) return;
    const interval = calendarIntervalFor(this.preferences.view, this.preferences.anchorDate, this.weekStartsOn);
    const key = intervalKey(interval);
    const existing = this.requests.get(key);
    if (existing) {
      if (!existing.controller.signal.aborted) {
        this.activeKey = key;
        return existing.promise;
      }
      // An obsolete request may still be awaiting a transport promise. It is
      // not a valid coalescing target; remove only the map entry and let its
      // generation/signal guard suppress its eventual completion.
      this.requests.delete(key);
    }

    // A new visible interval makes prior foreground work obsolete. The API
    // boundary has no payload-bearing cancellation parameter, so the loader's
    // signal suppresses every obsolete result and prevents partial commits.
    for (const [requestKey, request] of this.requests) {
      if (requestKey !== key) request.controller.abort();
    }
    this.activeKey = key;
    this.phase = this.hasCompleteData ? "refreshing" : "loading";
    this.errorState = null;
    this.emit();

    const requestController = new AbortController();
    const promise = this.runLoad(key, interval, requestController);
    const entry: InFlightLoad = { key, controller: requestController, promise };
    this.requests.set(key, entry);
    return promise;
  }

  /** Switches the authenticated namespace without allowing prior data to leak. */
  public replaceSession(input: {
    api?: CalendarApi;
    token: string;
    accountId?: string;
    userId?: string;
    backendId?: string;
    backendUrl?: string;
    baseUrl?: string;
  }): Promise<void> {
    if (this.disposed) return Promise.resolve();
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.activeKey = null;
    this.sessionGeneration += 1;
    this.api = input.api ?? this.api;
    this.token = input.token;
    this.accountId = input.accountId?.trim() || input.userId?.trim() || "";
    this.backendId = input.backendId?.trim() || input.backendUrl?.trim() || input.baseUrl?.trim() || (() => {
      try {
        return typeof globalThis.location !== "undefined" && globalThis.location.origin ? globalThis.location.origin : "default-backend";
      } catch {
        return "default-backend";
      }
    })();
    this.namespace = calendarPreferenceNamespace({ accountId: this.accountId, backendId: this.backendId });
    this.completeOccurrences = [];
    this.completeInterval = null;
    this.hasCompleteData = false;
    this.errorState = null;
    this.preferences = defaultCalendarPreferences(safeToday(this.now));
    this.preparePreferenceRead();
    this.phase = this.token ? "loading" : "idle";
    this.emit();
    this.readyPromise = this.initialize();
    return this.readyPromise;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.listeners.clear();
  }

  private preparePreferenceRead(): void {
    this.preferenceHydrated = false;
    this.pendingPreferenceRead = null;
    const namespace = this.namespace;
    if (!namespace) {
      this.preferenceHydrated = true;
      return;
    }
    try {
      const stored = this.preferenceStore.get(namespace);
      if (isPromiseLike(stored)) {
        this.pendingPreferenceRead = Promise.resolve(stored);
        return;
      }
      this.preferences = validateCalendarPreferences(stored, this.preferences);
      this.preferenceHydrated = true;
    } catch {
      this.preferenceHydrated = true;
    }
  }

  private async initialize(): Promise<void> {
    if (this.disposed) return;
    const generation = this.sessionGeneration;
    const namespace = this.namespace;
    if (namespace && !this.preferenceHydrated) {
      try {
        const stored = this.pendingPreferenceRead
          ? await this.pendingPreferenceRead
          : await this.preferenceStore.get(namespace);
        if (!this.disposed && generation === this.sessionGeneration) {
          this.preferences = validateCalendarPreferences(stored, this.preferences);
          this.preferenceHydrated = true;
          this.emit();
        }
      } catch {
        // Preference storage is advisory. Defaults remain isolated and valid.
        if (generation === this.sessionGeneration) this.preferenceHydrated = true;
      }
    }
    if (!this.disposed && generation === this.sessionGeneration && this.token) await this.refresh();
  }

  private persistPreferences(): void {
    if (!this.namespace) return;
    try {
      const result = this.preferenceStore.set(this.namespace, this.preferences);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // A disabled/full preference store cannot invalidate the calendar state.
    }
  }

  private async runLoad(key: string, interval: CalendarInterval, requestController: AbortController): Promise<void> {
    let result: CalendarPageAggregationResult;
    try {
      result = await loadCompleteCalendarInterval(this.api, this.token, interval, { signal: requestController.signal });
    } catch {
      result = { ok: false, error: controllerError("request-failed") };
    }

    const current = !this.disposed && this.activeKey === key && intervalKey(this.visibleInterval()) === key;
    const tracked = this.requests.get(key);
    if (tracked?.controller === requestController) this.requests.delete(key);
    if (!current || requestController.signal.aborted) return;
    if (result.ok) {
      this.completeOccurrences = result.value;
      this.completeInterval = interval;
      this.hasCompleteData = true;
      this.phase = "ready";
      this.errorState = null;
    } else if (result.error.code === "cancelled") {
      return;
    } else {
      // Keep the last complete set and its interval. A failed later page is
      // never allowed to replace it with a partial aggregate or an empty set.
      this.phase = "error";
      this.errorState = result.error;
    }
    this.emit();
  }

  private visibleInterval(): CalendarInterval {
    return calendarIntervalFor(this.preferences.view, this.preferences.anchorDate, this.weekStartsOn);
  }

  private buildState(): CalendarControllerSnapshot {
    const interval = this.visibleInterval();
    const filters = filtersFromPreferences(this.preferences);
    const filteredOccurrences = this.projectionFunctions.filterCalendarOccurrences(this.completeOccurrences, filters);
    const facets = this.projectionFunctions.deriveCalendarFacets(this.completeOccurrences, filters);
    const projection = this.projectionFunctions.projectCalendarInterval(
      this.preferences.view,
      interval,
      this.completeOccurrences,
      filteredOccurrences,
    );
    const isLoading = this.phase === "loading";
    const isRefreshing = this.phase === "refreshing";
    const isStale = this.hasCompleteData && (isRefreshing || this.phase === "error");
    const isFresh = this.hasCompleteData && this.phase === "ready";
    const freshness: CalendarFreshness = this.phase === "ready"
      ? "fresh"
      : this.phase === "error"
        ? "error"
        : this.phase === "refreshing"
          ? "refreshing"
          : this.phase === "loading"
            ? "loading"
            : "idle";
    const safeCount = filteredOccurrences.length;
    const noun = safeCount === 1 ? "event" : "events";
    const text = this.phase === "loading" && !this.hasCompleteData
      ? `Loading ${viewLabel(this.preferences.view)} calendar.`
      : this.phase === "error" && !this.hasCompleteData
        ? `${viewLabel(this.preferences.view)} calendar is unavailable.`
        : `${safeCount} ${noun} in ${viewLabel(this.preferences.view)} view.`;
    const loadStatus: CalendarLoadStatus = {
      phase: this.phase,
      freshness,
      isLoading,
      isRefreshing,
      isStale,
      isFresh,
      error: this.errorState,
    };
    const openAddEvent = () => this.openAddEvent();
    return {
      anchorDate: this.preferences.anchorDate,
      selectedDate: this.preferences.selectedDate,
      selectedView: this.preferences.view,
      view: this.preferences.view,
      visibleInterval: interval,
      completeOccurrences: this.completeOccurrences,
      occurrences: this.completeOccurrences,
      events: this.completeOccurrences,
      dataInterval: this.completeInterval,
      selectedFilters: filters,
      filters,
      filteredOccurrences,
      visibleOccurrences: filteredOccurrences,
      facets,
      facetOptions: facets,
      derivedFacets: facets,
      projection,
      projections: projection,
      status: this.phase,
      freshness,
      loadStatus,
      loading: isLoading,
      refreshing: isRefreshing,
      stale: isStale,
      fresh: isFresh,
      error: this.errorState,
      liveAnnouncement: text,
      resultAnnouncement: text,
      announcement: text,
      openAddEvent,
      addEventOpener: openAddEvent,
      onAddEvent: openAddEvent,
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.stateValue = this.buildState();
    for (const listener of this.listeners) {
      try {
        listener(this.stateValue);
      } catch {
        // A consumer listener must not interrupt data-state transitions.
      }
    }
  }
}

export function createCalendarController(options: CalendarControllerOptions): CalendarController {
  return new CalendarController(options);
}

export type CalendarControllerState = CalendarControllerSnapshot;
