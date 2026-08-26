import type { JSX } from "preact";
import { ActionButton, SegmentedControl } from "../common/index.ts";
import { Icon } from "../common/icon.tsx";
import type { CalendarViewMode } from "./calendar-projections.ts";
import {
  calendarIntervalFor,
  formatAccessibleCalendarDate,
  formatCalendarDate,
  isCalendarDate,
  type CalendarDate,
} from "./calendar-projections.ts";
import "./calendar-shell.css";

export const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = ["day", "week", "month", "year"];

export const CALENDAR_VIEW_LABELS: Readonly<Record<CalendarViewMode, string>> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};

const VIEW_DESCRIPTIONS: Readonly<Record<CalendarViewMode, string>> = {
  day: "A focused agenda with room for what changes next.",
  week: "Seven days of household commitments at a glance.",
  month: "Your household calendar in one place.",
  year: "Yearly patterns and family milestones.",
};

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
  readonly onAddEvent?: () => void;
  readonly addEventDisabled?: boolean;
}

export interface FloatingViewBarProps {
  readonly view?: CalendarViewMode;
  readonly selectedView?: CalendarViewMode;
  readonly onViewChange?: (view: CalendarViewMode) => void;
  readonly onChange?: (view: CalendarViewMode) => void;
  readonly label?: string;
}

function safeDate(value: string | undefined): CalendarDate {
  return value && isCalendarDate(value) ? value : ("1970-01-01" as CalendarDate);
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

/** Date navigation owns only navigation intent; the controller owns the date. */
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
  onAddEvent,
  addEventDisabled = false,
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
        <ActionButton className="calendar-nav-button" ariaLabel="Previous period" {...(onPrevious === undefined ? {} : { onClick: onPrevious })}>
          <Icon name="chevron" size={17} />
        </ActionButton>
        <ActionButton className="calendar-today-button" {...(onToday === undefined ? {} : { onClick: onToday })}>Today</ActionButton>
        <ActionButton className="calendar-nav-button calendar-nav-button--next" ariaLabel="Next period" {...(onNext === undefined ? {} : { onClick: onNext })}>
          <Icon name="chevron" size={17} />
        </ActionButton>
        {dateChange && <span hidden data-calendar-date-navigation-owned="true" />}
        {onAddEvent && (
          <ActionButton variant="primary" className="calendar-toolbar-add" ariaLabel="Add event" disabled={addEventDisabled} onClick={onAddEvent}>
            <span><Icon name="plus" size={16} /> Add event</span>
          </ActionButton>
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
      <SegmentedControl
        label={label}
        value={view}
        options={CALENDAR_VIEW_MODES.map((option) => ({ value: option, label: CALENDAR_VIEW_LABELS[option] }))}
        onChange={(value) => change?.(value as CalendarViewMode)}
      />
    </nav>
  );
}

export const CalendarDateNavigation = DateNavigation;
export const CalendarFloatingViewBar = FloatingViewBar;
export const CalendarViewBar = FloatingViewBar;
export const CalendarViewSwitcher = FloatingViewBar;
