import type { CalendarImportance, CalendarReadScope } from "../../services/calendar-api.ts";

/** The four calendar canvases supported by the web calendar. */
export type CalendarViewMode = "day" | "week" | "month" | "year";

export interface CalendarPreferences {
  version: 1;
  view: CalendarViewMode;
  /** The date used to derive the visible interval. */
  anchorDate: string;
  /** The selected date is kept separately for the canvas selection state. */
  selectedDate: string;
  scopes: readonly CalendarReadScope[];
  groups: readonly string[];
  tags: readonly string[];
  importance: CalendarImportance | null;
  search: string;
}

export interface CalendarPreferenceStore {
  get(namespace: string): CalendarPreferences | unknown | Promise<CalendarPreferences | unknown | null> | null;
  set(namespace: string, preferences: CalendarPreferences): void | Promise<void>;
}

export interface CalendarPreferenceNamespace {
  accountId: string;
  backendId: string;
}

export const DEFAULT_CALENDAR_VIEW: CalendarViewMode = "month";
export const DEFAULT_CALENDAR_SCOPES: readonly CalendarReadScope[] = ["all"];

const CALENDAR_VIEWS: readonly CalendarViewMode[] = ["day", "week", "month", "year"];
const CALENDAR_SCOPES: readonly CalendarReadScope[] = ["private", "household", "all"];
const CALENDAR_IMPORTANCE: readonly CalendarImportance[] = ["normal", "important", "pinned"];
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_FILTER_VALUE_LENGTH = 256;
const MAX_SEARCH_LENGTH = 512;
const MAX_FILTER_VALUES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isView(value: unknown): value is CalendarViewMode {
  return typeof value === "string" && CALENDAR_VIEWS.includes(value as CalendarViewMode);
}

function isScope(value: unknown): value is CalendarReadScope {
  return typeof value === "string" && CALENDAR_SCOPES.includes(value as CalendarReadScope);
}

function isImportance(value: unknown): value is CalendarImportance {
  return typeof value === "string" && CALENDAR_IMPORTANCE.includes(value as CalendarImportance);
}

/** Calendar dates are persisted as date identities, never as device-local timestamps. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function cleanValues(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (!cleaned || cleaned.length > maxLength || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= MAX_FILTER_VALUES) break;
  }
  return result;
}

function cleanScopes(value: unknown, fallback: readonly CalendarReadScope[] = DEFAULT_CALENDAR_SCOPES): CalendarReadScope[] {
  if (!Array.isArray(value)) return [...fallback];
  const result: CalendarReadScope[] = [];
  for (const item of value) {
    if (!isScope(item) || result.includes(item)) continue;
    result.push(item);
  }
  // "all" is the authorized aggregate selector. It is represented as the
  // sole default selection rather than being mixed with narrower selectors.
  if (result.includes("all")) return ["all"];
  return result.length ? result : [...fallback];
}

function cleanDate(value: unknown, fallback: string): string {
  return isCalendarDate(value) ? value : fallback;
}

/**
 * Return a validated preference snapshot. Invalid fields fall back one field at
 * a time so a bad persisted search does not discard a valid view or anchor.
 */
export function validateCalendarPreferences(value: unknown, fallback: CalendarPreferences): CalendarPreferences {
  const raw = isRecord(value) ? value : {};
  const anchorDate = cleanDate(raw.anchorDate, fallback.anchorDate);
  const selectedDate = cleanDate(raw.selectedDate, anchorDate);
  const importance = raw.importance === null || raw.importance === undefined || isImportance(raw.importance)
    ? (raw.importance === undefined ? fallback.importance : raw.importance)
    : fallback.importance;
  const search = typeof raw.search === "string" && raw.search.length <= MAX_SEARCH_LENGTH
    ? raw.search.trim()
    : fallback.search;
  return {
    version: 1,
    view: isView(raw.view) ? raw.view : fallback.view,
    anchorDate,
    selectedDate,
    scopes: raw.scopes === undefined ? [...fallback.scopes] : cleanScopes(raw.scopes, fallback.scopes),
    groups: raw.groups === undefined ? [...fallback.groups] : cleanValues(raw.groups, MAX_FILTER_VALUE_LENGTH),
    tags: raw.tags === undefined ? [...fallback.tags] : cleanValues(raw.tags, MAX_FILTER_VALUE_LENGTH),
    importance,
    search,
  };
}

/** Make a fresh validated default snapshot for a given current date. */
export function defaultCalendarPreferences(anchorDate: string): CalendarPreferences {
  const date = isCalendarDate(anchorDate) ? anchorDate : "1970-01-01";
  return {
    version: 1,
    view: DEFAULT_CALENDAR_VIEW,
    anchorDate: date,
    selectedDate: date,
    scopes: [...DEFAULT_CALENDAR_SCOPES],
    groups: [],
    tags: [],
    importance: null,
    search: "",
  };
}

/**
 * Namespace derivation is length-delimited and encoded as one storage segment,
 * preventing account/backend delimiter collisions and cross-backend reuse.
 */
export function calendarPreferenceNamespace(input: CalendarPreferenceNamespace): string | null {
  const accountId = input.accountId.trim();
  const backendId = input.backendId.trim();
  if (!accountId || !backendId) return null;
  try {
    return `account=${encodeURIComponent(accountId)}&backend=${encodeURIComponent(backendId)}`;
  } catch {
    return null;
  }
}

function storageKey(namespace: string): string {
  return `sentient:calendar:preferences:v1:${namespace}`;
}

/** Browser-backed preference persistence. Event data is never stored here. */
export function createCalendarPreferenceStore(storage?: Storage): CalendarPreferenceStore {
  let target = storage;
  if (!target) {
    try {
      target = typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : undefined;
    } catch {
      target = undefined;
    }
  }
  return {
    get(namespace) {
      if (!target) return null;
      try {
        const raw = target.getItem(storageKey(namespace));
        if (raw === null) return null;
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    set(namespace, preferences) {
      if (!target) return;
      try {
        target.setItem(storageKey(namespace), JSON.stringify(preferences));
      } catch {
        // A disabled or full browser store must not make calendar data fail.
      }
    },
  };
}

/** Small deterministic store useful for non-DOM consumers and unit tests. */
export function createMemoryCalendarPreferenceStore(
  initial: Readonly<Record<string, unknown>> = {},
): CalendarPreferenceStore & { readonly values: Map<string, CalendarPreferences> } {
  const values = new Map<string, CalendarPreferences>();
  for (const [namespace, value] of Object.entries(initial)) {
    if (isRecord(value)) values.set(namespace, value as unknown as CalendarPreferences);
  }
  return {
    values,
    get(namespace) {
      return values.get(namespace) ?? null;
    },
    set(namespace, preferences) {
      values.set(namespace, preferences);
    },
  };
}

export type CalendarPreferenceValue = CalendarPreferences;
