import { cloneElement, isValidElement } from "preact";
import type { ComponentChildren, JSX } from "preact";
import {
  CalendarActiveFilterSummary,
  CalendarCompactControls,
  CalendarFilterSidebar,
  type CalendarFilterControlsProps,
} from "./calendar-filter-controls.tsx";
import { clearCalendarFilters, normalizeCalendarFilters } from "./calendar-filter-model.ts";
import {
  CalendarDateNavigation,
  CalendarFloatingViewBar,
  CALENDAR_VIEW_LABELS,
  type CalendarDateNavigationProps,
  type FloatingViewBarProps,
} from "./calendar-toolbar.tsx";
import type {
  CalendarWorkspaceActions,
  CalendarWorkspaceModel,
  CalendarWorkspacePublicProps,
} from "./calendar-product-api.ts";
import type {
  CalendarCanvasCallbacks,
  CalendarCanvasChild,
  CalendarCanvasRenderSlot,
  CalendarCanvasSlotProps,
} from "./calendar-canvas-types.ts";
import type { CalendarFacets, CalendarFilters, CalendarViewMode } from "./calendar-projections.ts";
import { isCalendarDate, type CalendarDate } from "./calendar-projections.ts";
import "./calendar-shell.css";

/** Compatibility input retained for existing Calendar embedders. */
export interface CalendarWorkspaceCompatibilityProps extends CalendarFilterControlsProps, Pick<
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
  readonly children?: CalendarCanvasChild;
  readonly renderCanvas?: CalendarCanvasRenderSlot;
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
  readonly addEventDisabled?: boolean;
  readonly className?: string;
}

export type CalendarWorkspaceProps = CalendarWorkspacePublicProps | CalendarWorkspaceCompatibilityProps;

interface CalendarCanvasActionInputs extends CalendarCanvasCallbacks {
  readonly onDateChange?: (date: string) => void;
  readonly onAnchorDateChange?: (date: string) => void;
}

export const CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT = 900;
export const CALENDAR_SIDEBAR_BREAKPOINT = CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT;
export const CALENDAR_SIDEBAR_WIDTH = 244;

const DEFAULT_DATE = "1970-01-01" as CalendarDate;

function safeDate(value: string | undefined): CalendarDate {
  return value && isCalendarDate(value) ? value : DEFAULT_DATE;
}

function monthStartDate(year: number, month: number): CalendarDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01` as CalendarDate;
}

/** Normalize legacy callback aliases once, before the canvas slot boundary. */
function createCalendarCanvasActionAdapter(inputs: CalendarCanvasActionInputs): CalendarCanvasCallbacks {
  const anchorDateChange = inputs.onDateChange ?? inputs.onAnchorDateChange;
  const dateSelect = inputs.onSelectDate
    ?? inputs.onDateSelect
    ?? inputs.onOpenDay
    ?? inputs.onDaySelect
    ?? (anchorDateChange === undefined ? undefined : (date: CalendarDate) => anchorDateChange(date));
  const monthSelect = inputs.onSelectMonth
    ?? inputs.onMonthSelect
    ?? (anchorDateChange === undefined ? undefined : (year: number, month: number) => anchorDateChange(monthStartDate(year, month)));
  const eventOpen = inputs.onOpenEvent ?? inputs.onEventSelect ?? inputs.onEventClick;
  const overflowOpen = inputs.onOpenOverflow ?? inputs.onOverflow;
  return {
    ...(dateSelect === undefined ? {} : {
      onSelectDate: dateSelect,
      onDateSelect: dateSelect,
      onOpenDay: dateSelect,
      onDaySelect: dateSelect,
    }),
    ...(monthSelect === undefined ? {} : { onSelectMonth: monthSelect, onMonthSelect: monthSelect }),
    ...(eventOpen === undefined ? {} : { onOpenEvent: eventOpen, onEventSelect: eventOpen, onEventClick: eventOpen }),
    ...(overflowOpen === undefined ? {} : { onOpenOverflow: overflowOpen, onOverflow: overflowOpen }),
  };
}

function renderCanvasSlot(slot: CalendarCanvasChild | undefined, props: CalendarCanvasSlotProps): ComponentChildren {
  if (typeof slot === "function") return slot(props);
  if (isValidElement(slot) && typeof slot.type === "function") return cloneElement(slot, props);
  return slot;
}

function isPublicWorkspaceProps(props: CalendarWorkspaceProps): props is CalendarWorkspacePublicProps {
  return "model" in props && props.model !== undefined;
}

function workspaceModel(props: CalendarWorkspaceProps): CalendarWorkspaceModel {
  if (isPublicWorkspaceProps(props)) return props.model;
  const filters = props.selectedFilters ?? props.filters;
  const facets = props.facets ?? props.facetOptions ?? props.options;
  const liveAnnouncement = props.liveAnnouncement ?? props.resultAnnouncement ?? props.announcement;
  return {
    view: props.selectedView ?? props.view ?? "month",
    ...(props.selectedView === undefined ? {} : { selectedView: props.selectedView }),
    anchorDate: props.anchorDate ?? DEFAULT_DATE,
    ...(props.selectedDate === undefined ? {} : { selectedDate: props.selectedDate }),
    ...(filters === undefined ? {} : { filters }),
    ...(facets === undefined ? {} : { facets }),
    ...(props.projection === undefined ? {} : { projection: props.projection }),
    ...(props.loading === undefined ? {} : { loading: props.loading }),
    ...(props.refreshing === undefined ? {} : { refreshing: props.refreshing }),
    ...(props.emptyLabel === undefined ? {} : { emptyLabel: props.emptyLabel }),
    ...(props.resultCount === undefined ? {} : { resultCount: props.resultCount }),
    ...(liveAnnouncement === undefined ? {} : { liveAnnouncement }),
  };
}

function workspaceActions(props: CalendarWorkspaceProps): CalendarWorkspaceActions {
  if (isPublicWorkspaceProps(props)) return props.actions ?? {};
  const onFiltersChange = props.onFiltersChange ?? props.onFilterChange ?? props.onChange;
  const onDateChange = props.onDateChange ?? props.onAnchorDateChange;
  const onSelectDate = props.onSelectDate ?? props.onDateSelect ?? props.onOpenDay ?? props.onDaySelect;
  const onSelectMonth = props.onSelectMonth ?? props.onMonthSelect;
  const onOpenEvent = props.onOpenEvent ?? props.onEventSelect ?? props.onEventClick;
  const onOpenOverflow = props.onOpenOverflow ?? props.onOverflow;
  return {
    ...(onFiltersChange === undefined ? {} : { onFiltersChange }),
    ...(props.onViewChange === undefined ? {} : { onViewChange: props.onViewChange }),
    ...(props.onPrevious === undefined ? {} : { onPrevious: props.onPrevious }),
    ...(props.onNext === undefined ? {} : { onNext: props.onNext }),
    ...(props.onToday === undefined ? {} : { onToday: props.onToday }),
    ...(onDateChange === undefined ? {} : { onDateChange }),
    ...(props.onAddEvent === undefined ? {} : { onAddEvent: props.onAddEvent }),
    ...(onSelectDate === undefined ? {} : { onSelectDate }),
    ...(onSelectMonth === undefined ? {} : { onSelectMonth }),
    ...(onOpenEvent === undefined ? {} : { onOpenEvent }),
    ...(onOpenOverflow === undefined ? {} : { onOpenOverflow }),
  };
}

function workspaceChildren(props: CalendarWorkspaceProps): {
  readonly children?: CalendarCanvasChild;
  readonly renderCanvas?: CalendarCanvasRenderSlot;
  readonly canvas?: CalendarCanvasChild;
} {
  return {
    ...(props.children === undefined ? {} : { children: props.children }),
    ...(props.renderCanvas === undefined ? {} : { renderCanvas: props.renderCanvas }),
    ...(props.canvas === undefined ? {} : { canvas: props.canvas }),
  };
}

/**
 * Product workspace. It owns layout composition only; controller state and
 * overlay state remain at the CalendarView boundary.
 */
export function CalendarWorkspace(props: CalendarWorkspaceProps): JSX.Element {
  const model = workspaceModel(props);
  const actions = workspaceActions(props);
  const children = workspaceChildren(props);
  const view = model.selectedView ?? model.view;
  const anchorDate = safeDate(model.anchorDate);
  const selectedDate = safeDate(model.selectedDate ?? model.anchorDate);
  const filters = normalizeCalendarFilters(model.filters);
  const canvasActions = createCalendarCanvasActionAdapter(actions);
  const canvasSlotProps: CalendarCanvasSlotProps = {
    view,
    selectedView: view,
    anchorDate,
    selectedDate,
    filters,
    projection: model.projection ?? null,
    loading: model.loading ?? false,
    refreshing: model.refreshing ?? false,
    ...(model.emptyLabel === undefined ? {} : { emptyLabel: model.emptyLabel }),
    ...canvasActions,
  };
  const slot = children.renderCanvas ?? children.canvas ?? children.children;
  const generatedAnnouncement = model.resultCount === undefined
    ? `${CALENDAR_VIEW_LABELS[view]} calendar view.`
    : `${model.resultCount} ${model.resultCount === 1 ? "event" : "events"} in ${CALENDAR_VIEW_LABELS[view]} view.`;
  const statusText = model.liveAnnouncement ?? generatedAnnouncement;
  const legacyProps = isPublicWorkspaceProps(props) ? undefined : props;
  const clearFilters = legacyProps?.onClearFilters
    ?? actions.onClearFilters
    ?? (actions.onFiltersChange === undefined ? undefined : () => actions.onFiltersChange?.(clearCalendarFilters()));
  const filterProps: CalendarFilterControlsProps = {
    filters,
    ...(model.facets === undefined ? {} : { facets: model.facets }),
    ...(legacyProps?.facetOptions === undefined ? {} : { facetOptions: legacyProps.facetOptions }),
    ...(legacyProps?.options === undefined ? {} : { options: legacyProps.options }),
    ...(legacyProps?.scopeOptions === undefined ? {} : { scopeOptions: legacyProps.scopeOptions }),
    ...(legacyProps?.groupOptions === undefined ? {} : { groupOptions: legacyProps.groupOptions }),
    ...(legacyProps?.tagOptions === undefined ? {} : { tagOptions: legacyProps.tagOptions }),
    ...(legacyProps?.importanceOptions === undefined ? {} : { importanceOptions: legacyProps.importanceOptions }),
    ...(actions.onFiltersChange === undefined ? {} : { onFiltersChange: actions.onFiltersChange }),
    ...(legacyProps?.onFilterChange === undefined ? {} : { onFilterChange: legacyProps.onFilterChange }),
    ...(legacyProps?.onChange === undefined ? {} : { onChange: legacyProps.onChange }),
    ...(clearFilters === undefined ? {} : { onClearFilters: clearFilters }),
  };
  const rootClass = ["snt-plate", "calendar-workspace", props.className].filter(Boolean).join(" ");
  const addEventLabel = props.addEventLabel;
  const addEventDisabled = props.addEventDisabled;
  const dateNavigation: CalendarDateNavigationProps = {
    view,
    anchorDate,
    ...(props.weekStartsOn === undefined ? {} : { weekStartsOn: props.weekStartsOn }),
    ...(props.locale === undefined ? {} : { locale: props.locale }),
    ...(actions.onPrevious === undefined ? {} : { onPrevious: actions.onPrevious }),
    ...(actions.onNext === undefined ? {} : { onNext: actions.onNext }),
    ...(actions.onToday === undefined ? {} : { onToday: actions.onToday }),
    ...(actions.onDateChange === undefined ? {} : { onDateChange: actions.onDateChange }),
    ...(actions.onAddEvent === undefined ? {} : { onAddEvent: actions.onAddEvent }),
    addEventDisabled: addEventDisabled ?? false,
  };
  const viewSwitcher: FloatingViewBarProps = {
    view,
    ...(actions.onViewChange === undefined ? {} : { onViewChange: actions.onViewChange }),
  };

  return (
    <div
      class={rootClass}
      data-calendar-workspace
      data-sidebar-breakpoint={CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT}
      aria-busy={model.loading ?? false}
    >
      <CalendarFilterSidebar
        {...filterProps}
        {...(actions.onAddEvent === undefined ? {} : { onAddEvent: actions.onAddEvent })}
        addEventLabel={addEventLabel ?? "Add event"}
        addEventDisabled={addEventDisabled ?? false}
      />
      <main class="calendar-workspace__main" aria-labelledby="calendar-period-title">
        <CalendarDateNavigation {...dateNavigation} />
        <div class="calendar-workspace__compact">
          <CalendarCompactControls
            {...filterProps}
            {...(actions.onAddEvent === undefined ? {} : { onAddEvent: actions.onAddEvent })}
            addEventLabel={addEventLabel ?? "Add event"}
            addEventDisabled={addEventDisabled ?? false}
          />
        </div>
        <div class="calendar-workspace__canvas" data-calendar-canvas-slot aria-label="Calendar canvas">
          {renderCanvasSlot(slot, canvasSlotProps)}
        </div>
      </main>
      <CalendarFloatingViewBar {...viewSwitcher} />
      <p class="calendar-workspace__live-status" role="status" aria-live="polite" aria-atomic="true">{statusText}</p>
    </div>
  );
}

export type {
  CalendarFacets,
  CalendarFilters,
  CalendarViewMode,
  CalendarWorkspaceActions,
  CalendarWorkspaceModel,
  CalendarWorkspacePublicProps,
};
export type { CalendarCanvasChild, CalendarCanvasRenderSlot, CalendarCanvasSlotProps };
export {
  CalendarDateNavigation,
  CalendarFloatingViewBar,
  CALENDAR_VIEW_LABELS,
  CALENDAR_VIEW_MODES,
  formatCalendarPeriodTitle,
  DateNavigation,
  FloatingViewBar,
  CalendarViewBar,
  CalendarViewSwitcher,
} from "./calendar-toolbar.tsx";
export {
  CalendarActiveFilterSummary,
  CalendarFilterDialog,
  CalendarFilterPanel,
  CalendarSearchControl,
  CalendarCompactControls,
  CalendarFilterSidebar,
} from "./calendar-filter-controls.tsx";
export type {
  CalendarActiveFilterSummaryProps,
  CalendarCompactControlsProps,
  CalendarFilterControlsProps,
  CalendarFilterDialogProps,
  CalendarFilterPanelProps,
  CalendarFilterSidebarProps,
  CalendarSearchControlProps,
} from "./calendar-filter-controls.tsx";
export type { CalendarDateNavigationProps, FloatingViewBarProps } from "./calendar-toolbar.tsx";
export {
  activeCalendarFilterCount,
  activeCalendarFilters,
  clearCalendarFilters,
  normalizeCalendarFilters,
  normalizeCalendarShellFilters,
  removeCalendarFilter,
  selectedCalendarImportance,
  selectedCalendarGroups,
  selectedCalendarScopes,
  selectedCalendarSearch,
  selectedCalendarTags,
  CALENDAR_IMPORTANCE_VALUES,
  CALENDAR_SUPPORTED_SCOPES,
} from "./calendar-filter-model.ts";
export type {
  ActiveCalendarFilter,
  CalendarFacetEntry,
  CalendarFacetSource,
  CalendarFilterChangeHandler,
  CalendarFilterOption,
} from "./calendar-filter-model.ts";

/** Compatibility aliases for the original shell module. */
export const CalendarFilterSummary = CalendarActiveFilterSummary;
export const CalendarShell = CalendarWorkspace;
