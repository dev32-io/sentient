import type { ComponentChildren } from "preact";
import { ActionButton } from "../common/foundation.tsx";
import { activeCalendarFilterCount, selectedCalendarScopes } from "./calendar-filter-model.ts";
import type { CalendarFilters } from "./calendar-projections.ts";

/** Distinguish filtered absence from an actually empty complete interval. */
export function CalendarFilterResult({ filters, completeCount, resultCount, loading, onClear, children }: {
  filters: CalendarFilters;
  completeCount: number;
  resultCount: number;
  loading: boolean;
  onClear: () => void;
  children: ComponentChildren;
}) {
  const active = activeCalendarFilterCount(filters) > 0 || selectedCalendarScopes(filters).length === 0;
  if (loading || completeCount === 0 || resultCount !== 0 || !active) return <>{children}</>;
  return (
    <div class="calendar-filter-result" role="status">
      <p>No events match these filters. Your saved events are unchanged.</p>
      <ActionButton variant="default" onClick={onClear}>Clear filters</ActionButton>
    </div>
  );
}
