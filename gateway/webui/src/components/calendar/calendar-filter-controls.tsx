import type { ComponentChildren, JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { Dialog } from "../common/dialog.tsx";
import {
  ActionButton,
  CheckboxControl,
  ChipControl,
  Disclosure,
  SearchFilterBar,
} from "../common/index.ts";
import { Icon } from "../common/icon.tsx";
import type { CalendarImportance, CalendarReadScope } from "../../services/calendar-api.ts";
import type { CalendarFacets, CalendarFilters } from "./calendar-projections.ts";
import {
  activeCalendarFilterCount,
  activeCalendarFilters,
  calendarFacetSource,
  calendarFilterOptionLabel,
  calendarImportanceLabel,
  calendarScopeLabel,
  clearCalendarFilters,
  emitCalendarFilterChange,
  removeCalendarFilter,
  resolveCalendarFacetOptions,
  resolvedCalendarFilters,
  selectedCalendarImportance,
  updateCalendarFilters,
  CALENDAR_IMPORTANCE_VALUES,
  CALENDAR_SUPPORTED_SCOPES,
  type ActiveCalendarFilter,
  type CalendarFilterControlsProps,
} from "./calendar-filter-model.ts";
import "./calendar-shell.css";

export interface CalendarFilterSidebarProps extends CalendarFilterControlsProps {
  readonly onAddEvent?: () => void;
  readonly addEventLabel?: string;
  readonly addEventDisabled?: boolean;
}

export interface CalendarCompactControlsProps extends CalendarFilterControlsProps {
  readonly onAddEvent?: () => void;
  readonly addEventLabel?: string;
  readonly addEventDisabled?: boolean;
  readonly filterLabel?: string;
  /** Controlled popover state. Omit to use the component's local open state. */
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export interface CalendarActiveFilterSummaryProps {
  readonly filters?: CalendarFilters;
  readonly selectedFilters?: CalendarFilters;
  readonly onRemoveFilter?: (key: ActiveCalendarFilter["key"], value?: string) => void;
  readonly onRemove?: (key: ActiveCalendarFilter["key"], value?: string) => void;
  readonly onClearFilters?: () => void;
  readonly className?: string;
}

interface ResolvedFacetOption {
  readonly value: string;
  readonly count?: number;
}

export interface CalendarFilterPanelProps extends CalendarFilterControlsProps {
  readonly idPrefix: string;
  readonly className?: string;
  readonly includeSummary?: boolean;
}

export interface CalendarSearchControlProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label?: string;
  readonly placeholder?: string;
}

/** Named filter primitive keeps the native search input behind Calendar UI. */
export function CalendarSearchControl({ value, onChange, label = "Search calendar events", placeholder = "Search events" }: CalendarSearchControlProps): JSX.Element {
  return <SearchFilterBar value={value} label={label} placeholder={placeholder} onChange={onChange} />;
}

function FilterChip({
  label,
  selected,
  count,
  onClick,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly count?: number;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <ChipControl selected={selected} onClick={onClick}>
      <span class="calendar-filter-option__label">{label}</span>
      {count !== undefined && <span class="calendar-filter-option__count" aria-hidden="true">{count}</span>}
    </ChipControl>
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

/** The one filter panel is reused by roomy and compact Calendar controls. */
export function CalendarFilterPanel({
  idPrefix: _idPrefix,
  className = "",
  includeSummary = true,
  ...props
}: CalendarFilterPanelProps): JSX.Element {
  const filters = resolvedCalendarFilters(props);
  const source = calendarFacetSource(props);
  const groups: readonly ResolvedFacetOption[] = resolveCalendarFacetOptions(source, props.groupOptions, "groups", filters.groups ?? []);
  const tags: readonly ResolvedFacetOption[] = resolveCalendarFacetOptions(source, props.tagOptions, "tags", filters.tags ?? []);
  const importance: readonly ResolvedFacetOption[] = resolveCalendarFacetOptions(
    source,
    props.importanceOptions,
    "importance",
    selectedCalendarImportance(filters) ? [selectedCalendarImportance(filters) as CalendarImportance] : [],
    CALENDAR_IMPORTANCE_VALUES,
  );
  const scopes: readonly ResolvedFacetOption[] = resolveCalendarFacetOptions(
    source,
    props.scopeOptions,
    "scopes",
    filters.scopes ?? ["all"],
    CALENDAR_SUPPORTED_SCOPES,
  );
  const selectedScopeValues = filters.scopes ?? ["all"];
  const selectedScopes = new Set<CalendarReadScope>(
    selectedScopeValues.includes("all") ? CALENDAR_SUPPORTED_SCOPES : selectedScopeValues,
  );
  const selectedGroups = new Set(filters.groups ?? []);
  const selectedTags = new Set(filters.tags ?? []);
  const selectedImportance = selectedCalendarImportance(filters);

  const setScope = (scope: CalendarReadScope, checked: boolean): void => {
    const next = new Set(selectedScopes);
    if (checked) next.add(scope);
    else next.delete(scope);
    const values = CALENDAR_SUPPORTED_SCOPES.filter((value) => next.has(value));
    emitCalendarFilterChange(props, updateCalendarFilters(filters, {
      scopes: values.length === CALENDAR_SUPPORTED_SCOPES.length ? ["all"] : values,
    }));
  };

  const setGroup = (group: string): void => {
    const next = selectedGroups.has(group)
      ? [...selectedGroups].filter((value) => value !== group)
      : [...selectedGroups, group];
    emitCalendarFilterChange(props, updateCalendarFilters(filters, { groups: next }));
  };

  const setTag = (tag: string): void => {
    const next = selectedTags.has(tag)
      ? [...selectedTags].filter((value) => value !== tag)
      : [...selectedTags, tag];
    emitCalendarFilterChange(props, updateCalendarFilters(filters, { tags: next }));
  };

  const setImportance = (value: CalendarImportance): void => {
    emitCalendarFilterChange(props, updateCalendarFilters(filters, { importance: selectedImportance === value ? null : value }));
  };

  const clear = (): void => {
    if (props.onClearFilters) props.onClearFilters();
    else emitCalendarFilterChange(props, clearCalendarFilters());
  };

  return (
    <div class={`calendar-filter-panel ${className}`.trim()}>
      <CalendarSearchControl
        value={filters.search ?? ""}
        onChange={(value) => emitCalendarFilterChange(props, updateCalendarFilters(filters, { search: value }))}
      />
      <FilterSection label="Calendars">
        <div class="calendar-scope-options" role="group" aria-label="Calendar scope">
          {scopes.map((option) => {
            const value = option.value as CalendarReadScope;
            return (
              <CheckboxControl
                key={value}
                checked={selectedScopes.has(value)}
                onChange={(checked) => setScope(value, checked)}
                label={<><span>{calendarScopeLabel(value)}</span>{option.count !== undefined && <small aria-hidden="true">{option.count}</small>}</>}
              />
            );
          })}
        </div>
      </FilterSection>

      <FilterSection label="Importance">
        <div class="calendar-chip-cloud" role="group" aria-label="Calendar importance">
          {importance.map((option) => {
            const value = option.value as CalendarImportance;
            return <FilterChip key={value} label={calendarImportanceLabel(value)} selected={selectedImportance === value} {...(option.count === undefined ? {} : { count: option.count })} onClick={() => setImportance(value)} />;
          })}
        </div>
      </FilterSection>

      <div class="calendar-filter-disclosures snt-disclosures">
        <Disclosure
          className="calendar-filter-disclosure"
          title="Groups"
          description={selectedGroups.size ? `${selectedGroups.size} selected` : "None selected"}
        >
          <div class="calendar-chip-cloud">
            {groups.length > 0 ? groups.map((option) => <FilterChip key={option.value} label={calendarFilterOptionLabel(option.value)} selected={selectedGroups.has(option.value)} {...(option.count === undefined ? {} : { count: option.count })} onClick={() => setGroup(option.value)} />) : <p class="calendar-filter-empty">No groups available</p>}
          </div>
        </Disclosure>
        <Disclosure
          className="calendar-filter-disclosure"
          title="Tags"
          description={selectedTags.size ? `${selectedTags.size} selected` : "None selected"}
        >
          <div class="calendar-chip-cloud">
            {tags.length > 0 ? tags.map((option) => <FilterChip key={option.value} label={calendarFilterOptionLabel(option.value)} selected={selectedTags.has(option.value)} {...(option.count === undefined ? {} : { count: option.count })} onClick={() => setTag(option.value)} />) : <p class="calendar-filter-empty">No tags available</p>}
          </div>
        </Disclosure>
      </div>

      {includeSummary && (
        <CalendarActiveFilterSummary
          filters={filters}
          onRemoveFilter={(key, value) => emitCalendarFilterChange(props, removeCalendarFilter(filters, key, value))}
          onClearFilters={clear}
        />
      )}
    </div>
  );
}

export interface CalendarFilterDialogProps extends CalendarFilterControlsProps {
  readonly id: string;
  readonly open?: boolean;
  readonly onClose: () => void;
}

/** Compact filter dialog/sheet adapter; filter state remains controlled by the caller. */
export function CalendarFilterDialog({ id, open = true, onClose, ...props }: CalendarFilterDialogProps): JSX.Element | null {
  if (!open) return null;
  return (
    <div class="calendar-filter-drawer">
      <Dialog
        title="Calendar filters"
        description="Choose calendars, importance, groups, tags, and search."
        width={360}
        onClose={onClose}
        inertBackground
        footer={<ActionButton variant="quiet" onClick={onClose}>Done</ActionButton>}
      >
        <div id={id} class="calendar-filter-popover">
          <CalendarFilterPanel {...props} idPrefix={id} includeSummary />
        </div>
      </Dialog>
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
  const status = active.length === 0 ? "No active filters" : `${active.length} active ${active.length === 1 ? "filter" : "filters"}`;
  return (
    <section class={`calendar-active-filters ${className}`.trim()} aria-label="Active calendar filters">
      <p class="calendar-active-filters__status" aria-live="polite" title={active.map((item) => item.label).join(", ")}>{status}</p>
      {active.length > 0 && (
        <div class="calendar-active-filters__list" aria-live="polite">
          {active.map((item) => (
            <span class="calendar-active-filter" key={`${item.key}:${item.value ?? "search"}`}>
              <span class="calendar-active-filter__label">{item.label}</span>
              {remove && (
                <ActionButton
                  variant="quiet"
                  className="calendar-active-filter__remove"
                  ariaLabel={`Remove ${item.label} filter`}
                  onClick={() => remove(item.key, item.value)}
                >
                  <Icon name="x" size={12} />
                </ActionButton>
              )}
            </span>
          ))}
        </div>
      )}
      {active.length > 0 && <ActionButton variant="quiet" className="calendar-active-filters__clear" onClick={() => onClearFilters?.()}>Clear filters</ActionButton>}
    </section>
  );
}

export function CalendarFilterSidebar({
  onAddEvent,
  addEventLabel = "Add event",
  addEventDisabled = false,
  ...props
}: CalendarFilterSidebarProps): JSX.Element {
  return (
    <aside class="snt-plate calendar-filter-sidebar" data-calendar-filter-sidebar aria-label="Calendar filters">
      <header class="calendar-filter-sidebar__head">
        <h2>Filters</h2>
        <CalendarActiveFilterSummary
          filters={resolvedCalendarFilters(props)}
          onRemoveFilter={(key, value) => emitCalendarFilterChange(props, removeCalendarFilter(resolvedCalendarFilters(props), key, value))}
          {...(props.onClearFilters === undefined ? {} : { onClearFilters: props.onClearFilters })}
        />
      </header>
      <CalendarFilterPanel {...props} idPrefix="calendar-sidebar" includeSummary={false} />
      {onAddEvent && <span hidden data-calendar-add-event-available={!addEventDisabled} data-calendar-add-event-label={addEventLabel} />}
    </aside>
  );
}

let compactPopoverSequence = 0;

export function CalendarCompactControls({
  onAddEvent,
  addEventLabel = "Add event",
  addEventDisabled = false,
  filterLabel = "Filters",
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: CalendarCompactControlsProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useMemo(() => {
    compactPopoverSequence += 1;
    return `calendar-compact-filter-popover-${compactPopoverSequence}`;
  }, []);
  const isOpen = open ?? uncontrolledOpen;
  const filters = resolvedCalendarFilters(props);
  const activeCount = activeCalendarFilterCount(filters);

  const setOpen = (next: boolean): void => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <section class="calendar-compact-controls" data-calendar-compact-controls aria-label="Compact calendar controls">
      <div class="calendar-compact-controls__row">
        <ActionButton variant="primary" className="calendar-add-event" ariaLabel={addEventLabel} onClick={() => onAddEvent?.()} disabled={addEventDisabled}>
          <Icon name="plus" size={16} />
          <span>{addEventLabel}</span>
        </ActionButton>
        <div class="calendar-compact-controls__filter-anchor">
          <ActionButton
            buttonRef={triggerRef}
            className="calendar-filter-trigger"
            hasPopup="dialog"
            aria-expanded={isOpen}
            aria-controls={popoverId}
            ariaLabel={activeCount > 0 ? `${filterLabel}, ${activeCount} active filters` : `Open ${filterLabel.toLowerCase()}`}
            onClick={() => setOpen(!isOpen)}
          >
            <Icon name="sliders-h" size={16} />
            <span>{filterLabel}</span>
            {activeCount > 0 && <span class="calendar-filter-trigger__count" aria-label={`${activeCount} active`}>{activeCount}</span>}
          </ActionButton>
          {isOpen && <CalendarFilterDialog {...props} id={popoverId} onClose={() => setOpen(false)} />}
        </div>
      </div>
    </section>
  );
}

export {
  activeCalendarFilterCount,
  activeCalendarFilters,
  clearCalendarFilters,
  normalizeCalendarFilters,
  normalizeCalendarFilters as normalizeCalendarShellFilters,
  removeCalendarFilter,
  selectedCalendarImportance,
  selectedCalendarGroups,
  selectedCalendarScopes,
  selectedCalendarSearch,
  selectedCalendarTags,
} from "./calendar-filter-model.ts";
export type {
  ActiveCalendarFilter,
  CalendarFacetEntry,
  CalendarFacetSource,
  CalendarFilterChangeHandler,
  CalendarFilterOption,
  CalendarFilterControlsProps,
} from "./calendar-filter-model.ts";
export { CALENDAR_IMPORTANCE_VALUES, CALENDAR_SUPPORTED_SCOPES } from "./calendar-filter-model.ts";
export type { CalendarFacets, CalendarFilters };
