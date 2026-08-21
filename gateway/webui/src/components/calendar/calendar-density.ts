import type {
  CalendarDensityOptions,
  CalendarDensityProjection,
  CalendarEventIndicator,
  CalendarEventPresentation,
  CalendarEventPresentationMode,
  ProjectedCalendarOccurrence,
} from "./calendar-projection-types.ts";

const DEFAULT_MAX_VISIBLE_EVENTS = 3;
const DEFAULT_MAX_INDICATORS = 3;

function truncate(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0 || value.length <= maxCharacters) return value;
  if (maxCharacters === 1) return "…";
  return `${value.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function indicatorFor(event: ProjectedCalendarOccurrence): CalendarEventIndicator {
  return {
    eventId: event.eventId,
    occurrenceId: event.occurrenceId,
    kind: event.start.kind,
    importance: event.importance,
    accessibleName: event.accessibleName,
  };
}

function visualLabel(
  event: ProjectedCalendarOccurrence,
  mode: CalendarEventPresentationMode,
  maxTitleCharacters: number,
): string {
  if (mode === "dot") return "";
  if (mode === "truncated-pill") return truncate(event.title, maxTitleCharacters);
  return event.start.kind === "all-day"
    ? event.title
    : `${event.title} · ${event.start.displayTime ?? event.start.label}`;
}

export function presentCalendarEvent(
  event: ProjectedCalendarOccurrence,
  mode: CalendarEventPresentationMode = "full-pill",
  maxTitleCharacters = 48,
): CalendarEventPresentation {
  return {
    event,
    mode,
    visualLabel: visualLabel(event, mode, maxTitleCharacters),
    accessibleName: event.accessibleName,
    indicator: indicatorFor(event),
  };
}

/**
 * Choose a representation explicitly at a responsive boundary. No DOM size is
 * measured here, and every source event remains in `events`/`overflowEvents`.
 */
export function projectCalendarDensity(
  events: readonly ProjectedCalendarOccurrence[],
  options: CalendarDensityOptions = {},
): CalendarDensityProjection {
  const mode = options.mode ?? "full-pill";
  const maxVisibleEvents =
    options.maxVisibleEvents === undefined
      ? DEFAULT_MAX_VISIBLE_EVENTS
      : Math.max(0, Math.floor(options.maxVisibleEvents));
  const maxIndicators =
    options.maxIndicators === undefined ? DEFAULT_MAX_INDICATORS : Math.max(0, Math.floor(options.maxIndicators));
  const maxTitleCharacters = options.maxTitleCharacters ?? 48;
  const presentations = events.map((event) => presentCalendarEvent(event, mode, maxTitleCharacters));
  const visibleEvents = presentations.slice(0, maxVisibleEvents);
  const overflowEvents = presentations.slice(maxVisibleEvents);
  const indicators = presentations.slice(0, maxIndicators).map((presentation) => presentation.indicator);
  return {
    mode,
    events: presentations,
    visibleEvents,
    overflowEvents,
    indicators,
    overflowCount: overflowEvents.length,
    ...(overflowEvents.length > 0 && options.dateLabel
      ? { overflowLabel: `+${overflowEvents.length} more events on ${options.dateLabel}` }
      : {}),
  };
}

export const projectEventDensity = projectCalendarDensity;
export const chooseCalendarEventPresentation = presentCalendarEvent;
