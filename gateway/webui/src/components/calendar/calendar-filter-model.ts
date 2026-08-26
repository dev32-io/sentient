import type { CalendarImportance, CalendarReadScope } from "../../services/calendar-api.ts";
import type { CalendarFacets, CalendarFilters } from "./calendar-projections.ts";

export const CALENDAR_SUPPORTED_SCOPES: readonly CalendarReadScope[] = ["private", "household"];
export const CALENDAR_IMPORTANCE_VALUES: readonly CalendarImportance[] = ["normal", "important", "pinned"];

const DEFAULT_FILTERS: CalendarFilters = {
  scopes: ["all"],
  groups: [],
  tags: [],
  importance: null,
  search: "",
};

const SCOPE_LABELS: Record<CalendarReadScope, string> = {
  private: "Private",
  household: "Household",
  all: "Private and Household",
};

const IMPORTANCE_LABELS: Record<CalendarImportance, string> = {
  normal: "Normal",
  important: "Important",
  pinned: "Pinned",
};

type FilterFacetKey = "scopes" | "groups" | "tags" | "importance";
export type CalendarFacetEntry = string | { readonly value?: unknown; readonly count?: unknown };

/** Controller facets and embedding-friendly option aliases share this source. */
export interface CalendarFacetSource {
  readonly scopes?: readonly CalendarFacetEntry[];
  readonly groups?: readonly CalendarFacetEntry[];
  readonly tags?: readonly CalendarFacetEntry[];
  readonly importance?: readonly CalendarFacetEntry[];
  readonly scopeOptions?: readonly CalendarFacetEntry[];
  readonly groupOptions?: readonly CalendarFacetEntry[];
  readonly tagOptions?: readonly CalendarFacetEntry[];
  readonly importanceOptions?: readonly CalendarFacetEntry[];
}

export interface CalendarFilterOption {
  readonly value: string;
  readonly count?: number;
}

export type CalendarFilterChangeHandler = (filters: CalendarFilters) => void;

/** The filter seam is controlled by the screen; controls never own server data. */
export interface CalendarFilterControlsProps {
  readonly filters?: CalendarFilters;
  /** Alias accepted by controller-shaped callers. */
  readonly selectedFilters?: CalendarFilters;
  readonly facets?: CalendarFacetSource | CalendarFacets;
  readonly facetOptions?: CalendarFacetSource;
  readonly options?: CalendarFacetSource;
  readonly scopeOptions?: readonly CalendarFacetEntry[];
  readonly groupOptions?: readonly CalendarFacetEntry[];
  readonly tagOptions?: readonly CalendarFacetEntry[];
  readonly importanceOptions?: readonly CalendarFacetEntry[];
  readonly onFiltersChange?: CalendarFilterChangeHandler;
  readonly onFilterChange?: CalendarFilterChangeHandler;
  readonly onChange?: CalendarFilterChangeHandler;
  readonly onClearFilters?: () => void;
}

export interface ActiveCalendarFilter {
  readonly key: "scope" | "group" | "tag" | "importance" | "search";
  readonly value?: string;
  readonly label: string;
}

function isCalendarImportance(value: string): value is CalendarImportance {
  return CALENDAR_IMPORTANCE_VALUES.includes(value as CalendarImportance);
}

function isCalendarScope(value: string): value is CalendarReadScope {
  return value === "all" || CALENDAR_SUPPORTED_SCOPES.includes(value as CalendarReadScope);
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function filterState(filters?: CalendarFilters): CalendarFilters {
  const source = filters ?? DEFAULT_FILTERS;
  const rawScopes = source.scopes ?? (source.scope === undefined ? ["all"] : [source.scope]);
  const scopes = uniqueStrings(rawScopes.filter(isCalendarScope));
  const normalizedScopes: CalendarReadScope[] = scopes.includes("all") ? ["all"] : scopes;
  const rawGroups = source.groups ?? (source.group === undefined ? [] : [source.group]);
  const importanceSource: readonly CalendarImportance[] =
    source.importanceValues ??
    (source.importance === undefined || source.importance === null
      ? []
      : Array.isArray(source.importance)
        ? source.importance
        : [source.importance]);
  const importance = uniqueStrings(importanceSource.filter(isCalendarImportance));
  const search = (source.search ?? source.text ?? source.query ?? "").trim();
  return {
    scopes: normalizedScopes,
    groups: uniqueStrings(rawGroups),
    tags: uniqueStrings(source.tags ?? []),
    importance: importance[0] ?? null,
    search,
  };
}

/** Return the canonical, controller-compatible filter shape used by Calendar. */
export function normalizeCalendarFilters(filters?: CalendarFilters): CalendarFilters {
  return filterState(filters);
}

/** Compatibility name retained for callers of the original shell module. */
export const normalizeCalendarShellFilters = normalizeCalendarFilters;

export function selectedCalendarScopes(filters?: CalendarFilters): readonly CalendarReadScope[] {
  return filterState(filters).scopes ?? ["all"];
}

export function selectedCalendarGroups(filters?: CalendarFilters): readonly string[] {
  return filterState(filters).groups ?? [];
}

export function selectedCalendarTags(filters?: CalendarFilters): readonly string[] {
  return filterState(filters).tags ?? [];
}

export function selectedCalendarImportance(filters?: CalendarFilters): CalendarImportance | null {
  const value = filterState(filters).importance;
  return typeof value === "string" && isCalendarImportance(value) ? value : null;
}

export function selectedCalendarSearch(filters?: CalendarFilters): string {
  return filterState(filters).search ?? "";
}

export function clearCalendarFilters(): CalendarFilters {
  return { ...DEFAULT_FILTERS, scopes: ["all"], groups: [], tags: [], importance: null, search: "" };
}

export function updateCalendarFilters(
  filters: CalendarFilters | undefined,
  patch: Partial<CalendarFilters>,
): CalendarFilters {
  return filterState({ ...filterState(filters), ...patch });
}

export function removeCalendarFilter(
  filters: CalendarFilters | undefined,
  key: ActiveCalendarFilter["key"],
  value?: string,
): CalendarFilters {
  const current = filterState(filters);
  if (key === "scope" && value !== undefined) {
    const scopes = (current.scopes ?? []).filter((scope) => scope !== value);
    return filterState({ ...current, scopes });
  }
  if (key === "group" && value !== undefined) {
    return filterState({ ...current, groups: (current.groups ?? []).filter((group) => group !== value) });
  }
  if (key === "tag" && value !== undefined) {
    return filterState({ ...current, tags: (current.tags ?? []).filter((tag) => tag !== value) });
  }
  if (key === "importance") return filterState({ ...current, importance: null });
  if (key === "search") return filterState({ ...current, search: "" });
  return current;
}

export function activeCalendarFilters(filters?: CalendarFilters): readonly ActiveCalendarFilter[] {
  const current = filterState(filters);
  const active: ActiveCalendarFilter[] = [];
  for (const scope of current.scopes ?? []) {
    if (scope !== "all") active.push({ key: "scope", value: scope, label: SCOPE_LABELS[scope] });
  }
  for (const group of current.groups ?? []) active.push({ key: "group", value: group, label: `Group: ${group}` });
  for (const tag of current.tags ?? []) active.push({ key: "tag", value: tag, label: `Tag: ${tag}` });
  const currentImportance = selectedCalendarImportance(current);
  if (currentImportance) {
    active.push({
      key: "importance",
      value: currentImportance,
      label: `Importance: ${IMPORTANCE_LABELS[currentImportance]}`,
    });
  }
  if (current.search) active.push({ key: "search", label: `Search: ${current.search}` });
  return active;
}

export function activeCalendarFilterCount(filters?: CalendarFilters): number {
  return activeCalendarFilters(filters).length;
}

export function calendarScopeLabel(scope: CalendarReadScope): string {
  return SCOPE_LABELS[scope];
}

export function calendarImportanceLabel(importance: CalendarImportance): string {
  return IMPORTANCE_LABELS[importance];
}

function facetValues(
  source: CalendarFacetSource | CalendarFacets | undefined,
  key: FilterFacetKey,
): readonly CalendarFacetEntry[] {
  if (!source) return [];
  const candidate = (source as CalendarFacetSource)[key];
  if (Array.isArray(candidate)) return candidate;
  const aliases: Record<FilterFacetKey, keyof CalendarFacetSource> = {
    scopes: "scopeOptions",
    groups: "groupOptions",
    tags: "tagOptions",
    importance: "importanceOptions",
  };
  const alias = (source as CalendarFacetSource)[aliases[key]];
  return Array.isArray(alias) ? alias : [];
}

function facetEntry(entry: CalendarFacetEntry): CalendarFilterOption | null {
  if (typeof entry === "string") return { value: entry };
  if (typeof entry.value !== "string" || entry.value.length === 0) return null;
  return {
    value: entry.value,
    ...(typeof entry.count === "number" && Number.isFinite(entry.count) && entry.count >= 0
      ? { count: Math.floor(entry.count) }
      : {}),
  };
}

export function resolveCalendarFacetOptions(
  source: CalendarFacetSource | CalendarFacets | undefined,
  direct: readonly CalendarFacetEntry[] | undefined,
  key: FilterFacetKey,
  selected: readonly string[],
  allowed?: readonly string[],
): readonly CalendarFilterOption[] {
  const entries = direct ?? facetValues(source, key);
  const result = new Map<string, CalendarFilterOption>();
  for (const entry of entries) {
    const parsed = facetEntry(entry);
    if (!parsed || (allowed && !allowed.includes(parsed.value))) continue;
    result.set(parsed.value, parsed);
  }
  for (const value of allowed ?? []) {
    if (!result.has(value)) result.set(value, { value });
  }
  for (const value of selected) {
    if (!allowed || allowed.includes(value)) {
      if (!result.has(value)) result.set(value, { value });
    }
  }
  return [...result.values()].sort((a, b) => {
    if (allowed) return allowed.indexOf(a.value) - allowed.indexOf(b.value);
    return a.value.localeCompare(b.value);
  });
}

export function calendarFacetSource(
  props: CalendarFilterControlsProps,
): CalendarFacetSource | CalendarFacets | undefined {
  return props.facets ?? props.facetOptions ?? props.options;
}

export function emitCalendarFilterChange(props: CalendarFilterControlsProps, next: CalendarFilters): void {
  const handler = props.onFiltersChange ?? props.onFilterChange ?? props.onChange;
  handler?.(next);
}

export function resolvedCalendarFilters(props: CalendarFilterControlsProps): CalendarFilters {
  return filterState(props.selectedFilters ?? props.filters);
}

export function calendarFilterOptionLabel(value: string): string {
  return value.length > 0 ? value : "Unnamed";
}
