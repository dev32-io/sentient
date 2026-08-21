import type { CalendarImportance, CalendarReadScope, CalendarScope } from "../../services/calendar-api.ts";
import { compareProjectedCalendarOccurrences, projectCalendarOccurrences } from "./calendar-occurrence.ts";
import type {
  CalendarFacetOption,
  CalendarFacets,
  CalendarFilteredProjection,
  CalendarFilters,
  CalendarOccurrenceInput,
  CalendarProjectionOptions,
} from "./calendar-projection-types.ts";

const IMPORTANCE_VALUES: readonly CalendarImportance[] = ["normal", "important", "pinned"];

function field(value: CalendarOccurrenceInput, name: string): unknown {
  return (value as unknown as Record<string, unknown>)[name];
}

function stringField(value: CalendarOccurrenceInput, name: string): string | undefined {
  const candidate = field(value, name);
  return typeof candidate === "string" ? candidate : undefined;
}

function listField(value: CalendarOccurrenceInput, name: string): readonly string[] {
  const candidate = field(value, name);
  return Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))];
}

function sortStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function selectedScopeValues(filters: CalendarFilters): readonly CalendarReadScope[] {
  const values = filters.scopes ?? (filters.scope === undefined ? [] : [filters.scope]);
  return [...new Set(values)].filter(
    (value): value is CalendarReadScope => value === "private" || value === "household" || value === "all",
  );
}

function selectedGroupValues(filters: CalendarFilters): readonly string[] {
  return uniqueStrings(filters.groups ?? (filters.group === undefined ? [] : [filters.group]));
}

function selectedImportanceValues(filters: CalendarFilters): readonly CalendarImportance[] {
  const source =
    filters.importanceValues ??
    (filters.importance === undefined
      ? []
      : Array.isArray(filters.importance)
        ? filters.importance
        : [filters.importance]);
  return [...new Set(source)].filter((value): value is CalendarImportance => IMPORTANCE_VALUES.includes(value));
}

function selectedText(filters: CalendarFilters): string {
  return (filters.text ?? filters.query ?? "").trim().toLowerCase();
}

export interface NormalizedCalendarFilters {
  readonly scopes: readonly CalendarReadScope[];
  readonly groups: readonly string[];
  readonly tags: readonly string[];
  readonly importance: readonly CalendarImportance[];
  readonly text: string;
}

export function normalizeCalendarFilters(filters: CalendarFilters = {}): NormalizedCalendarFilters {
  return {
    scopes: selectedScopeValues(filters),
    groups: selectedGroupValues(filters),
    tags: uniqueStrings(filters.tags),
    importance: selectedImportanceValues(filters),
    text: selectedText(filters),
  };
}

function matchesScope(value: CalendarScope, scopes: readonly CalendarReadScope[]): boolean {
  if (scopes.length === 0 || scopes.includes("all")) return true;
  return scopes.includes(value);
}

function matchesText(value: CalendarOccurrenceInput, needle: string): boolean {
  if (!needle) return true;
  const haystack = [stringField(value, "title") ?? "", stringField(value, "description") ?? ""]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Apply all selected dimensions as an intersection over the complete set. */
export function calendarOccurrenceMatchesFilters(
  value: CalendarOccurrenceInput,
  filters: CalendarFilters = {},
): boolean {
  const normalized = normalizeCalendarFilters(filters);
  if (!matchesScope(field(value, "scope") === "household" ? "household" : "private", normalized.scopes)) return false;
  if (normalized.groups.length > 0) {
    const group = stringField(value, "group");
    if (!group || !normalized.groups.includes(group)) return false;
  }
  if (normalized.tags.length > 0) {
    const tags = new Set(listField(value, "tags"));
    if (!normalized.tags.every((tag) => tags.has(tag))) return false;
  }
  if (normalized.importance.length > 0) {
    const importance = field(value, "importance");
    if (typeof importance !== "string" || !normalized.importance.includes(importance as CalendarImportance))
      return false;
  }
  return matchesText(value, normalized.text);
}

export function filterCalendarOccurrences(
  values: readonly CalendarOccurrenceInput[],
  filters: CalendarFilters = {},
): CalendarOccurrenceInput[] {
  return values.filter((value) => calendarOccurrenceMatchesFilters(value, filters));
}

function facetOptions(
  values: Iterable<string>,
  counts: ReadonlyMap<string, number>,
  selected: readonly string[],
): CalendarFacetOption[] {
  const all = new Set(values);
  for (const value of selected) all.add(value);
  return sortStrings(all).map((value) => ({
    value,
    count: counts.get(value) ?? 0,
    selected: selected.includes(value),
  }));
}

function countOccurrences(
  values: readonly CalendarOccurrenceInput[],
  read: (value: CalendarOccurrenceInput) => readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    for (const facet of read(value)) counts.set(facet, (counts.get(facet) ?? 0) + 1);
  }
  return counts;
}

/**
 * Derive options from the complete authorized set, not the currently filtered
 * result. Selected absent values are retained with count zero so a user can
 * remove a stale filter without losing the control.
 */
export function deriveCalendarFacets(
  values: readonly CalendarOccurrenceInput[],
  filters: CalendarFilters = {},
): CalendarFacets {
  const normalized = normalizeCalendarFilters(filters);
  const scopeCounts = new Map<string, number>();
  for (const value of values) {
    const scope = field(value, "scope") === "household" ? "household" : "private";
    scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
  }
  const scopeValues = new Set<string>(scopeCounts.keys());
  const selectedScopes = normalized.scopes;
  for (const scope of selectedScopes) scopeValues.add(scope);
  if (values.length > 0 || selectedScopes.includes("all")) scopeValues.add("all");
  const scopeOptionCounts = new Map(scopeCounts);
  scopeOptionCounts.set("all", values.length);
  const scopeOptions = facetOptions(scopeValues, scopeOptionCounts, selectedScopes);

  const groupCounts = countOccurrences(values, (value) => {
    const group = stringField(value, "group");
    return group === undefined ? [] : [group];
  });
  const tagCounts = countOccurrences(values, (value) => listField(value, "tags"));
  const importanceCounts = countOccurrences(values, (value) => {
    const importance = field(value, "importance");
    return typeof importance === "string" && IMPORTANCE_VALUES.includes(importance as CalendarImportance)
      ? [importance]
      : [];
  });
  const importanceOptions = facetOptions(importanceCounts.keys(), importanceCounts, normalized.importance).map(
    (option) => ({
      ...option,
      value: option.value as CalendarImportance,
    }),
  );
  const groups = facetOptions(groupCounts.keys(), groupCounts, normalized.groups);
  const tags = facetOptions(tagCounts.keys(), tagCounts, normalized.tags);
  return {
    scopes: scopeOptions,
    groups,
    tags,
    importance: importanceOptions,
    scopeOptions: scopeOptions.map((option) => option.value),
    groupOptions: groups.map((option) => option.value),
    tagOptions: tags.map((option) => option.value),
    importanceOptions: importanceOptions.map((option) => option.value),
  };
}

/** One derivation seam for controllers: filter rows, retain complete-data facets, and project rows. */
export function deriveCalendarProjection(
  values: readonly CalendarOccurrenceInput[],
  filters: CalendarFilters = {},
  options: CalendarProjectionOptions = {},
): CalendarFilteredProjection {
  const filteredOccurrences = filterCalendarOccurrences(values, filters);
  const displayOptions = {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    ...((options.timeZone ?? options.deviceTimeZone ?? options.timeZoneId) !== undefined
      ? { timeZone: options.timeZone ?? options.deviceTimeZone ?? options.timeZoneId }
      : {}),
    ...(options.deviceTimeZone !== undefined ? { deviceTimeZone: options.deviceTimeZone } : {}),
  };
  const projectedOccurrences = projectCalendarOccurrences(filteredOccurrences, displayOptions).sort(
    compareProjectedCalendarOccurrences,
  );
  return {
    occurrences: values,
    filteredOccurrences,
    filtered: filteredOccurrences,
    projectedOccurrences,
    events: projectedOccurrences,
    filters,
    facets: deriveCalendarFacets(values, filters),
  };
}

export const deriveCalendarFilterProjection = deriveCalendarProjection;
export const applyCalendarFilters = filterCalendarOccurrences;
export const getCalendarFacets = deriveCalendarFacets;
