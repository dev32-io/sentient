import { cloneElement, isValidElement } from "preact";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../common/icon.tsx";
import type { CalendarImportance, CalendarReadScope } from "../../services/calendar-api.ts";
import type { CalendarFacets, CalendarFilters, CalendarViewMode } from "./calendar-projections.ts";
import type {
  CalendarCanvasCallbacks,
  CalendarCanvasChild,
  CalendarCanvasRenderSlot,
  CalendarCanvasSlotProps,
} from "./calendar-canvas-types.ts";
import {
  calendarIntervalFor,
  formatAccessibleCalendarDate,
  formatCalendarDate,
  isCalendarDate,
  type CalendarDate,
} from "./calendar-projections.ts";
import "./calendar-shell.css";

/** The reviewed responsive boundary for the roomy sidebar. */
export const CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT = 900;
export const CALENDAR_SIDEBAR_BREAKPOINT = CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT;
export const CALENDAR_SIDEBAR_WIDTH = 244;

export const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = ["day", "week", "month", "year"];
export const CALENDAR_SUPPORTED_SCOPES: readonly CalendarReadScope[] = ["private", "household", "all"];
export const CALENDAR_IMPORTANCE_VALUES: readonly CalendarImportance[] = ["normal", "important", "pinned"];

const DEFAULT_DATE = "1970-01-01" as CalendarDate;
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
  all: "All calendars",
};

const IMPORTANCE_LABELS: Record<CalendarImportance, string> = {
  normal: "Normal",
  important: "Important",
  pinned: "Pinned",
};

const VIEW_LABELS: Record<CalendarViewMode, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};

const VIEW_DESCRIPTIONS: Record<CalendarViewMode, string> = {
  day: "A focused agenda with room for what changes next.",
  week: "Seven days of household commitments at a glance.",
  month: "Your household calendar in one place.",
  year: "Yearly patterns and family milestones.",
};

type FilterFacetKey = "scopes" | "groups" | "tags" | "importance";

type FacetEntry = string | { readonly value?: unknown; readonly count?: unknown };

/** Facets may come from either the controller's string arrays or rich projections. */
export interface CalendarFacetSource {
  readonly scopes?: readonly FacetEntry[];
  readonly groups?: readonly FacetEntry[];
  readonly tags?: readonly FacetEntry[];
  readonly importance?: readonly FacetEntry[];
  readonly scopeOptions?: readonly FacetEntry[];
  readonly groupOptions?: readonly FacetEntry[];
  readonly tagOptions?: readonly FacetEntry[];
  readonly importanceOptions?: readonly FacetEntry[];
}

export interface CalendarFilterOption {
  readonly value: string;
  readonly count?: number;
}

export type CalendarFilterChangeHandler = (filters: CalendarFilters) => void;

export interface CalendarFilterControlsProps {
  readonly filters?: CalendarFilters;
  /** Alias accepted by controller-shaped callers. */
  readonly selectedFilters?: CalendarFilters;
  readonly facets?: CalendarFacetSource | CalendarFacets;
  readonly facetOptions?: CalendarFacetSource;
  readonly options?: CalendarFacetSource;
  readonly scopeOptions?: readonly FacetEntry[];
  readonly groupOptions?: readonly FacetEntry[];
  readonly tagOptions?: readonly FacetEntry[];
  readonly importanceOptions?: readonly FacetEntry[];
  readonly onFiltersChange?: CalendarFilterChangeHandler;
  readonly onFilterChange?: CalendarFilterChangeHandler;
  readonly onChange?: CalendarFilterChangeHandler;
  readonly onClearFilters?: () => void;
}

export interface CalendarFilterSidebarProps extends CalendarFilterControlsProps {
  readonly onAddEvent?: () => void;
  readonly addEventLabel?: string;
}

export interface CalendarCompactControlsProps extends CalendarFilterControlsProps {
  readonly onAddEvent?: () => void;
  readonly addEventLabel?: string;
  readonly filterLabel?: string;
  /** Controlled popover state. Omit to use the component's local open state. */
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export interface CalendarDateNavigationProps {
  readonly view?: CalendarViewMode;
  readonly selectedView?: CalendarViewMode;
  readonly anchorDate?: string;
  /** Alias useful to callers that call the anchor the selected date. */
  readonly date?: string;
  readonly weekStartsOn?: 0 | 1;
  readonly locale?: string;
  readonly subtitle?: string;
  readonly headingId?: string;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onToday?: () => void;
  readonly onDateChange?: (date: string) => void;
  readonly onAnchorDateChange?: (date: string) => void;
}

export interface FloatingViewBarProps {
  readonly view?: CalendarViewMode;
  readonly selectedView?: CalendarViewMode;
  readonly onViewChange?: (view: CalendarViewMode) => void;
  readonly onChange?: (view: CalendarViewMode) => void;
  readonly label?: string;
}

export interface CalendarActiveFilterSummaryProps {
  readonly filters?: CalendarFilters;
  readonly selectedFilters?: CalendarFilters;
  readonly onRemoveFilter?: (key: ActiveCalendarFilter["key"], value?: string) => void;
  readonly onRemove?: (key: ActiveCalendarFilter["key"], value?: string) => void;
  readonly onClearFilters?: () => void;
  readonly className?: string;
}

export interface ActiveCalendarFilter {
  readonly key: "scope" | "group" | "tag" | "importance" | "search";
  readonly value?: string;
  readonly label: string;
}

export interface CalendarWorkspaceProps extends CalendarFilterControlsProps, Pick<
  CalendarCanvasCallbacks,
  | "onSelectDate"
  | "onDateSelect"
  | "onOpenDay"
  | "onDaySelect"
  | "onSelectMonth"
  | "onMonthSelect"
  | "onOpenEvent"
  | "onEventSelect"
  | "onEventClick"
  | "onOpenOverflow"
  | "onOverflow"
> {
  /** The active canvas can be supplied as typed children. */
  readonly children?: CalendarCanvasChild;
  /** Explicit render-slot form for canvases that need shell state. */
  readonly renderCanvas?: CalendarCanvasRenderSlot;
  /** Alias for callers that prefer a named canvas slot. */
  readonly canvas?: CalendarCanvasChild;
  readonly view?: CalendarViewMode;
  readonly selectedView?: CalendarViewMode;
  readonly anchorDate?: string;
  readonly selectedDate?: string;
  readonly weekStartsOn?: 0 | 1;
  readonly locale?: string;
  readonly resultCount?: number;
  readonly liveAnnouncement?: string;
  readonly resultAnnouncement?: string;
  readonly announcement?: string;
  readonly loading?: boolean;
  /** Complete rich projection supplied by the controller/route boundary. */
  readonly projection?: CalendarCanvasSlotProps["projection"];
  readonly refreshing?: boolean;
  readonly emptyLabel?: string;
  readonly onViewChange?: (view: CalendarViewMode) => void;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onToday?: () => void;
  readonly onDateChange?: (date: string) => void;
  readonly onAnchorDateChange?: (date: string) => void;
  readonly onAddEvent?: () => void;
  readonly addEventLabel?: string;
  readonly className?: string;
}

interface ResolvedFacetOption {
  readonly value: string;
  readonly count?: number;
}

interface FilterPanelProps extends CalendarFilterControlsProps {
  readonly idPrefix: string;
  readonly className?: string;
  readonly includeSummary?: boolean;
}

function isCalendarImportance(value: string): value is CalendarImportance {
  return CALENDAR_IMPORTANCE_VALUES.includes(value as CalendarImportance);
}

function isCalendarScope(value: string): value is CalendarReadScope {
  return CALENDAR_SUPPORTED_SCOPES.includes(value as CalendarReadScope);
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function filterState(filters?: CalendarFilters): CalendarFilters {
  const source = filters ?? DEFAULT_FILTERS;
  const rawScopes = source.scopes ?? (source.scope === undefined ? [] : [source.scope]);
  const scopes = uniqueStrings(rawScopes.filter(isCalendarScope));
  const normalizedScopes: CalendarReadScope[] = scopes.includes("all") ? ["all"] : scopes.length > 0 ? scopes : ["all"];
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

/** Return the canonical, controller-compatible filter shape used by this shell. */
export function normalizeCalendarShellFilters(filters?: CalendarFilters): CalendarFilters {
  return filterState(filters);
}

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

function updateFilterState(filters: CalendarFilters | undefined, patch: Partial<CalendarFilters>): CalendarFilters {
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
    return filterState({ ...current, scopes: scopes.length > 0 ? scopes : ["all"] });
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
    active.push({ key: "importance", value: currentImportance, label: `Importance: ${IMPORTANCE_LABELS[currentImportance]}` });
  }
  if (current.search) active.push({ key: "search", label: `Search: ${current.search}` });
  return active;
}

export function activeCalendarFilterCount(filters?: CalendarFilters): number {
  return activeCalendarFilters(filters).length;
}

function facetValues(source: CalendarFacetSource | CalendarFacets | undefined, key: FilterFacetKey): readonly FacetEntry[] {
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

function facetEntry(entry: FacetEntry): { value: string; count?: number } | null {
  if (typeof entry === "string") return { value: entry };
  if (typeof entry.value !== "string" || entry.value.length === 0) return null;
  return {
    value: entry.value,
    ...(typeof entry.count === "number" && Number.isFinite(entry.count) && entry.count >= 0
      ? { count: Math.floor(entry.count) }
      : {}),
  };
}

function resolveFacetOptions(
  source: CalendarFacetSource | CalendarFacets | undefined,
  direct: readonly FacetEntry[] | undefined,
  key: FilterFacetKey,
  selected: readonly string[],
  allowed?: readonly string[],
): readonly ResolvedFacetOption[] {
  const entries = direct ?? facetValues(source, key);
  const result = new Map<string, ResolvedFacetOption>();
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

function resolvedFacetSource(props: CalendarFilterControlsProps): CalendarFacetSource | CalendarFacets | undefined {
  return props.facets ?? props.facetOptions ?? props.options;
}

function emitFilterChange(props: CalendarFilterControlsProps, next: CalendarFilters): void {
  const handler = props.onFiltersChange ?? props.onFilterChange ?? props.onChange;
  handler?.(next);
}

function resolvedFilters(props: CalendarFilterControlsProps): CalendarFilters {
  return filterState(props.selectedFilters ?? props.filters);
}

function optionLabel(value: string): string {
  return value.length > 0 ? value : "Unnamed";
}

function FilterToggle({
  label,
  selected,
  count,
  onClick,
  className = "",
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly count?: number;
  readonly onClick: () => void;
  readonly className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      class={`calendar-filter-option ${className}`.trim()}
      aria-pressed={selected}
      aria-label={count === undefined ? label : `${label}, ${count} events`}
      onClick={onClick}
    >
      <span class="calendar-filter-option__mark" aria-hidden="true">{selected ? "✓" : ""}</span>
      <span class="calendar-filter-option__label">{label}</span>
      {count !== undefined && <span class="calendar-filter-option__count" aria-hidden="true">{count}</span>}
    </button>
  );
}

function FilterSection({
  label,
  children,
  className = "",
}: {
  readonly label: string;
  readonly children: ComponentChildren;
  readonly className?: string;
}): JSX.Element {
  return (
    <section class={`calendar-filter-section ${className}`.trim()}>
      <h3 class="calendar-filter-section__label">{label}</h3>
      {children}
    </section>
  );
}

function CalendarFilterPanel({
  idPrefix,
  className = "",
  includeSummary = true,
  ...props
}: FilterPanelProps): JSX.Element {
  const filters = resolvedFilters(props);
  const source = resolvedFacetSource(props);
  const groups = resolveFacetOptions(source, props.groupOptions, "groups", filters.groups ?? []);
  const tags = resolveFacetOptions(source, props.tagOptions, "tags", filters.tags ?? []);
  const importance = resolveFacetOptions(
    source,
    props.importanceOptions,
    "importance",
    selectedCalendarImportance(filters) ? [selectedCalendarImportance(filters) as CalendarImportance] : [],
    CALENDAR_IMPORTANCE_VALUES,
  );
  const scopes = resolveFacetOptions(
    source,
    props.scopeOptions,
    "scopes",
    filters.scopes ?? ["all"],
    CALENDAR_SUPPORTED_SCOPES,
  );
  const selectedScopes = new Set<CalendarReadScope>(filters.scopes ?? ["all"]);
  const selectedGroups = new Set(filters.groups ?? []);
  const selectedTags = new Set(filters.tags ?? []);
  const selectedImportance = selectedCalendarImportance(filters);
  const searchId = `${idPrefix}-search`;

  const setScopes = (scope: CalendarReadScope): void => {
    const next: CalendarReadScope[] = scope === "all"
      ? ["all" as CalendarReadScope]
      : (selectedScopes.has("all") ? [] : [...selectedScopes]).filter((value) => value !== "all");
    if (scope !== "all") {
      if (selectedScopes.has(scope)) next.splice(next.indexOf(scope), 1);
      else next.push(scope);
    }
    emitFilterChange(props, updateFilterState(filters, { scopes: next.length > 0 ? next : ["all" as CalendarReadScope] }));
  };

  const setGroup = (group: string): void => {
    const next = selectedGroups.has(group)
      ? [...selectedGroups].filter((value) => value !== group)
      : [...selectedGroups, group];
    emitFilterChange(props, updateFilterState(filters, { groups: next }));
  };

  const setTag = (tag: string): void => {
    const next = selectedTags.has(tag)
      ? [...selectedTags].filter((value) => value !== tag)
      : [...selectedTags, tag];
    emitFilterChange(props, updateFilterState(filters, { tags: next }));
  };

  const setImportance = (value: CalendarImportance): void => {
    emitFilterChange(props, updateFilterState(filters, { importance: selectedImportance === value ? null : value }));
  };

  const clear = (): void => {
    if (props.onClearFilters) props.onClearFilters();
    else emitFilterChange(props, clearCalendarFilters());
  };

  return (
    <div class={`calendar-filter-panel ${className}`.trim()}>
      <FilterSection label="Scope">
        <div class="calendar-filter-options" role="group" aria-label="Calendar scope">
          {scopes.map((option) => {
            const value = option.value as CalendarReadScope;
            return (
              <FilterToggle
                key={value}
                label={SCOPE_LABELS[value]}
                selected={selectedScopes.has(value)}
                {...(option.count === undefined ? {} : { count: option.count })}
                onClick={() => setScopes(value)}
                className="calendar-filter-option--scope"
              />
            );
          })}
        </div>
      </FilterSection>

      <FilterSection label="Groups">
        {groups.length > 0 ? (
          <div class="calendar-filter-options" role="group" aria-label="Calendar groups">
            {groups.map((option) => (
              <FilterToggle
                key={option.value}
                label={optionLabel(option.value)}
                selected={selectedGroups.has(option.value)}
                {...(option.count === undefined ? {} : { count: option.count })}
                onClick={() => setGroup(option.value)}
              />
            ))}
          </div>
        ) : (
          <p class="calendar-filter-empty">No groups available</p>
        )}
      </FilterSection>

      <FilterSection label="Tags">
        {tags.length > 0 ? (
          <div class="calendar-filter-tags" role="group" aria-label="Calendar tags">
            {tags.map((option) => (
              <button
                type="button"
                key={option.value}
                class="calendar-filter-tag"
                aria-pressed={selectedTags.has(option.value)}
                aria-label={option.count === undefined ? `Tag ${optionLabel(option.value)}` : `Tag ${optionLabel(option.value)}, ${option.count} events`}
                onClick={() => setTag(option.value)}
              >
                {optionLabel(option.value)}
                {option.count !== undefined && <span class="calendar-filter-tag__count" aria-hidden="true">{option.count}</span>}
              </button>
            ))}
          </div>
        ) : (
          <p class="calendar-filter-empty">No tags available</p>
        )}
      </FilterSection>

      <FilterSection label="Importance">
        <div class="calendar-filter-options" role="group" aria-label="Calendar importance">
          {importance.map((option) => {
            const value = option.value as CalendarImportance;
            return (
              <FilterToggle
                key={value}
                label={IMPORTANCE_LABELS[value]}
                selected={selectedImportance === value}
                {...(option.count === undefined ? {} : { count: option.count })}
                onClick={() => setImportance(value)}
              />
            );
          })}
        </div>
      </FilterSection>

      <FilterSection label="Search" className="calendar-filter-section--search">
        <label class="calendar-filter-search" for={searchId}>
          <span class="calendar-filter-search__label">Search calendar events</span>
          <span class="calendar-filter-search__field">
            <Icon name="search" size={15} />
            <input
              id={searchId}
              type="search"
              value={filters.search ?? ""}
              placeholder="Search events"
              onInput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                emitFilterChange(props, updateFilterState(filters, { search: value }));
              }}
            />
          </span>
        </label>
      </FilterSection>

      {includeSummary && (
        <CalendarActiveFilterSummary
          filters={filters}
          onRemoveFilter={(key, value) => emitFilterChange(props, removeCalendarFilter(filters, key, value))}
          onClearFilters={clear}
        />
      )}
    </div>
  );
}

export function CalendarActiveFilterSummary({
  filters,
  selectedFilters,
  onRemoveFilter,
  onRemove,
  onClearFilters,
  className = "",
}: CalendarActiveFilterSummaryProps): JSX.Element {
  const active = activeCalendarFilters(selectedFilters ?? filters);
  const remove = onRemoveFilter ?? onRemove;
  return (
    <section class={`calendar-active-filters ${className}`.trim()} aria-label="Active calendar filters">
      <div class="calendar-active-filters__head">
        <h3>Active filters</h3>
        {active.length > 0 && (
          <button type="button" class="calendar-active-filters__clear" onClick={onClearFilters}>
            Clear all
          </button>
        )}
      </div>
      {active.length > 0 ? (
        <div class="calendar-active-filters__list" aria-live="polite">
          {active.map((item) => (
            <span class="calendar-active-filter" key={`${item.key}:${item.value ?? "search"}`}>
              <span class="calendar-active-filter__label">{item.label}</span>
              <button
                type="button"
                class="calendar-active-filter__remove"
                aria-label={`Remove ${item.label} filter`}
                onClick={() => remove?.(item.key, item.value)}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p class="calendar-active-filters__empty">No filters applied</p>
      )}
    </section>
  );
}

export function CalendarFilterSidebar({
  onAddEvent,
  addEventLabel = "Add event",
  ...props
}: CalendarFilterSidebarProps): JSX.Element {
  return (
    <aside class="calendar-filter-sidebar" data-calendar-filter-sidebar aria-label="Calendar filters">
      <button type="button" class="calendar-add-event" onClick={() => onAddEvent?.()}>
        <Icon name="plus" size={16} />
        <span>{addEventLabel}</span>
      </button>
      <header class="calendar-filter-sidebar__head">
        <h2>Filters</h2>
        <p>Show the calendars and details that matter now.</p>
      </header>
      <CalendarFilterPanel {...props} idPrefix="calendar-sidebar" />
    </aside>
  );
}

let compactPopoverSequence = 0;

export function CalendarCompactControls({
  onAddEvent,
  addEventLabel = "Add event",
  filterLabel = "Filters",
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: CalendarCompactControlsProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(false);
  const popoverId = useMemo(() => {
    compactPopoverSequence += 1;
    return `calendar-compact-filter-popover-${compactPopoverSequence}`;
  }, []);
  const headingId = `${popoverId}-heading`;
  const isOpen = open ?? uncontrolledOpen;
  const filters = resolvedFilters(props);
  const activeCount = activeCalendarFilterCount(filters);

  const setOpen = (next: boolean): void => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      const first = panelRef.current?.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      first?.focus();
    } else if (!isOpen && wasOpen.current) {
      triggerRef.current?.focus();
    }
    wasOpen.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen]);

  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };

  return (
    <section class="calendar-compact-controls" data-calendar-compact-controls aria-label="Compact calendar controls">
      <div class="calendar-compact-controls__row">
        <button type="button" class="calendar-add-event" onClick={() => onAddEvent?.()}>
          <Icon name="plus" size={16} />
          <span>{addEventLabel}</span>
        </button>
        <div class="calendar-compact-controls__filter-anchor">
          <button
            ref={triggerRef}
            type="button"
            class="calendar-filter-trigger"
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-controls={popoverId}
            aria-label={activeCount > 0 ? `${filterLabel}, ${activeCount} active filters` : `Open ${filterLabel.toLowerCase()}`}
            onClick={() => setOpen(!isOpen)}
          >
            <Icon name="sliders-h" size={16} />
            <span>{filterLabel}</span>
            {activeCount > 0 && <span class="calendar-filter-trigger__count" aria-label={`${activeCount} active`}>{activeCount}</span>}
          </button>
          {isOpen && (
            <div
              ref={panelRef}
              id={popoverId}
              class="calendar-filter-popover"
              role="dialog"
              aria-modal="false"
              aria-labelledby={headingId}
              onKeyDown={closeOnEscape}
            >
              <header class="calendar-filter-popover__head">
                <div>
                  <h2 id={headingId}>Calendar filters</h2>
                  <p>Choose supported calendars, facets, and text.</p>
                </div>
                <button type="button" class="calendar-filter-popover__close" aria-label="Close calendar filters" onClick={() => setOpen(false)}>
                  <Icon name="x" size={16} />
                </button>
              </header>
              <CalendarFilterPanel {...props} idPrefix={popoverId} includeSummary />
            </div>
          )}
        </div>
      </div>
      <CalendarActiveFilterSummary
        filters={filters}
        onRemoveFilter={(key, value) => emitFilterChange(props, removeCalendarFilter(filters, key, value))}
        onClearFilters={() => {
          if (props.onClearFilters) props.onClearFilters();
          else emitFilterChange(props, clearCalendarFilters());
        }}
        className="calendar-compact-controls__summary"
      />
    </section>
  );
}

function safeDate(value: string | undefined): CalendarDate {
  return value && isCalendarDate(value) ? value : DEFAULT_DATE;
}

function periodTitle(view: CalendarViewMode, anchorDate: CalendarDate, weekStartsOn: 0 | 1, locale?: string): string {
  const options = { ...(locale === undefined ? {} : { locale }), timeZone: "UTC" };
  if (view === "day") return formatAccessibleCalendarDate(anchorDate, options);
  if (view === "year") return new Intl.DateTimeFormat(locale, { year: "numeric", timeZone: "UTC" }).format(new Date(`${anchorDate}T12:00:00Z`));
  if (view === "month") {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${anchorDate}T12:00:00Z`));
  }
  const interval = calendarIntervalFor("week", anchorDate, weekStartsOn);
  return `${formatCalendarDate(interval.from as CalendarDate, options)}–${formatCalendarDate(interval.to as CalendarDate, options)}`;
}

export function formatCalendarPeriodTitle(
  view: CalendarViewMode,
  anchorDate: string,
  options: { readonly weekStartsOn?: 0 | 1; readonly locale?: string } = {},
): string {
  return periodTitle(view, safeDate(anchorDate), options.weekStartsOn ?? 1, options.locale);
}

export function DateNavigation({
  view: suppliedView,
  selectedView,
  anchorDate: suppliedAnchorDate,
  date,
  weekStartsOn = 1,
  locale,
  subtitle,
  headingId = "calendar-period-title",
  onPrevious,
  onNext,
  onToday,
  onDateChange,
  onAnchorDateChange,
}: CalendarDateNavigationProps): JSX.Element {
  const view = selectedView ?? suppliedView ?? "month";
  const anchorDate = safeDate(suppliedAnchorDate ?? date);
  const description = subtitle ?? VIEW_DESCRIPTIONS[view];
  const dateChange = onDateChange ?? onAnchorDateChange;
  return (
    <header class="calendar-date-navigation" data-calendar-date-navigation>
      <div class="calendar-date-navigation__title">
        <h1 id={headingId}>{periodTitle(view, anchorDate, weekStartsOn, locale)}</h1>
        <p>{description}</p>
      </div>
      <div class="calendar-date-navigation__actions" role="group" aria-label="Date navigation">
        <button type="button" class="calendar-today-button" onClick={onToday}>Today</button>
        <button type="button" class="calendar-nav-button" aria-label="Previous period" onClick={onPrevious}>
          <Icon name="chevron" size={17} />
        </button>
        <button type="button" class="calendar-nav-button calendar-nav-button--next" aria-label="Next period" onClick={onNext}>
          <Icon name="chevron" size={17} />
        </button>
        {dateChange && (
          <input
            class="calendar-date-navigation__picker"
            type="date"
            aria-label="Choose calendar date"
            value={anchorDate}
            onChange={(event) => dateChange((event.currentTarget as HTMLInputElement).value)}
          />
        )}
      </div>
    </header>
  );
}

export function FloatingViewBar({
  view: suppliedView,
  selectedView,
  onViewChange,
  onChange,
  label = "Calendar view",
}: FloatingViewBarProps): JSX.Element {
  const view = selectedView ?? suppliedView ?? "month";
  const change = onViewChange ?? onChange;
  return (
    <nav class="calendar-floating-view-bar" data-calendar-floating-view-bar aria-label={label}>
      {CALENDAR_VIEW_MODES.map((option) => (
        <button
          type="button"
          key={option}
          class={`calendar-view-button ${view === option ? "calendar-view-button--active" : ""}`.trim()}
          aria-pressed={view === option}
          aria-label={`${VIEW_LABELS[option]} view`}
          onClick={() => change?.(option)}
        >
          {VIEW_LABELS[option]}
        </button>
      ))}
    </nav>
  );
}

function renderCanvasSlot(slot: CalendarCanvasChild | undefined, props: CalendarCanvasSlotProps): ComponentChildren {
  if (typeof slot === "function") return slot(props);
  // A component-valued child is still a slot: clone it with the same shared
  // contract, while leaving static DOM children untouched.
  if (isValidElement(slot) && typeof slot.type === "function") return cloneElement(slot, props);
  return slot;
}

export function CalendarWorkspace({
  children,
  renderCanvas,
  canvas,
  view: suppliedView,
  selectedView,
  anchorDate: suppliedAnchorDate,
  selectedDate: suppliedSelectedDate,
  weekStartsOn = 1,
  locale,
  filters: suppliedFilters,
  selectedFilters,
  facets,
  facetOptions,
  options,
  scopeOptions,
  groupOptions,
  tagOptions,
  importanceOptions,
  onFiltersChange,
  onFilterChange,
  onChange,
  onClearFilters,
  resultCount,
  liveAnnouncement,
  resultAnnouncement,
  announcement,
  loading = false,
  projection,
  refreshing = false,
  emptyLabel,
  onSelectDate,
  onDateSelect,
  onOpenDay,
  onDaySelect,
  onSelectMonth,
  onMonthSelect,
  onOpenEvent,
  onEventSelect,
  onEventClick,
  onOpenOverflow,
  onOverflow,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  onDateChange,
  onAnchorDateChange,
  onAddEvent,
  addEventLabel = "Add event",
  className = "",
}: CalendarWorkspaceProps): JSX.Element {
  const view = selectedView ?? suppliedView ?? "month";
  const anchorDate = suppliedAnchorDate && isCalendarDate(suppliedAnchorDate) ? suppliedAnchorDate : DEFAULT_DATE;
  const selectedDate = suppliedSelectedDate && isCalendarDate(suppliedSelectedDate) ? suppliedSelectedDate : anchorDate;
  const filters = filterState(selectedFilters ?? suppliedFilters);
  const canvasDateSelect = onSelectDate ?? (onDateChange === undefined ? undefined : (date: CalendarDate) => onDateChange(date));
  const canvasMonthSelect = onSelectMonth ?? onMonthSelect ?? (onDateChange === undefined
    ? undefined
    : (year: number, month: number) => onDateChange(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`));
  const canvasSlotProps: CalendarCanvasSlotProps = {
    view,
    selectedView: view,
    anchorDate,
    selectedDate,
    filters,
    projection: projection ?? null,
    loading,
    refreshing,
    ...(emptyLabel === undefined ? {} : { emptyLabel }),
    ...(canvasDateSelect === undefined ? {} : { onSelectDate: canvasDateSelect }),
    ...(onDateSelect === undefined ? {} : { onDateSelect }),
    ...(onOpenDay === undefined ? {} : { onOpenDay }),
    ...(onDaySelect === undefined ? {} : { onDaySelect }),
    ...(canvasMonthSelect === undefined ? {} : { onSelectMonth: canvasMonthSelect }),
    ...(onOpenEvent === undefined ? {} : { onOpenEvent }),
    ...(onEventSelect === undefined ? {} : { onEventSelect }),
    ...(onEventClick === undefined ? {} : { onEventClick }),
    ...(onOpenOverflow === undefined ? {} : { onOpenOverflow }),
    ...(onOverflow === undefined ? {} : { onOverflow }),
  };
  const slot = renderCanvas ?? canvas ?? children;
  const generatedAnnouncement = resultCount === undefined
    ? `${VIEW_LABELS[view]} calendar view.`
    : `${resultCount} ${resultCount === 1 ? "event" : "events"} in ${VIEW_LABELS[view]} view.`;
  const statusText = liveAnnouncement ?? resultAnnouncement ?? announcement ?? generatedAnnouncement;
  const filterProps: CalendarFilterControlsProps = {
    filters,
    ...(facets === undefined ? {} : { facets }),
    ...(facetOptions === undefined ? {} : { facetOptions }),
    ...(options === undefined ? {} : { options }),
    ...(scopeOptions === undefined ? {} : { scopeOptions }),
    ...(groupOptions === undefined ? {} : { groupOptions }),
    ...(tagOptions === undefined ? {} : { tagOptions }),
    ...(importanceOptions === undefined ? {} : { importanceOptions }),
    ...(onFiltersChange === undefined ? {} : { onFiltersChange }),
    ...(onFilterChange === undefined ? {} : { onFilterChange }),
    ...(onChange === undefined ? {} : { onChange }),
    ...(onClearFilters === undefined ? {} : { onClearFilters }),
  };
  const rootClass = ["calendar-workspace", className].filter(Boolean).join(" ");
  return (
    <div
      class={rootClass}
      data-calendar-workspace
      data-sidebar-breakpoint={CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT}
      aria-busy={loading}
    >
      <CalendarFilterSidebar
        {...filterProps}
        {...(onAddEvent === undefined ? {} : { onAddEvent })}
        addEventLabel={addEventLabel}
      />
      <main class="calendar-workspace__main" aria-labelledby="calendar-period-title">
        <DateNavigation
          view={view}
          anchorDate={anchorDate}
          weekStartsOn={weekStartsOn}
          {...(locale === undefined ? {} : { locale })}
          {...(onPrevious === undefined ? {} : { onPrevious })}
          {...(onNext === undefined ? {} : { onNext })}
          {...(onToday === undefined ? {} : { onToday })}
          {...(onDateChange === undefined ? {} : { onDateChange })}
          {...(onAnchorDateChange === undefined ? {} : { onAnchorDateChange })}
        />
        <div class="calendar-workspace__compact">
          <CalendarCompactControls
            {...filterProps}
            {...(onAddEvent === undefined ? {} : { onAddEvent })}
            addEventLabel={addEventLabel}
          />
        </div>
        <div class="calendar-workspace__canvas" data-calendar-canvas-slot aria-label="Calendar canvas">
          {renderCanvasSlot(slot, canvasSlotProps)}
        </div>
      </main>
      <FloatingViewBar
        view={view}
        {...(onViewChange === undefined ? {} : { onViewChange })}
      />
      <p class="calendar-workspace__live-status" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </p>
    </div>
  );
}

export const CalendarDateNavigation = DateNavigation;
export const CalendarFloatingViewBar = FloatingViewBar;
export const CalendarViewBar = FloatingViewBar;
export const CalendarFilterSummary = CalendarActiveFilterSummary;
export const CalendarShell = CalendarWorkspace;

export type {
  CalendarCanvasChild,
  CalendarCanvasRenderSlot,
  CalendarCanvasSlotProps,
  CalendarFacets,
  CalendarFilters,
  CalendarViewMode,
};
