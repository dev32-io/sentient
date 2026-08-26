import type { CalendarApi } from "../../services/calendar-api.ts";
import type { CalendarAccessCapabilities } from "./calendar-access.ts";
import type {
  CalendarCanvasCallbacks,
  CalendarCanvasChild,
  CalendarCanvasRenderSlot,
} from "./calendar-canvas-types.ts";
import type { CalendarFacetSource } from "./calendar-filter-model.ts";
import type { CalendarPreferenceStore } from "./calendar-preferences.ts";
import type { CalendarViewProjection } from "./calendar-projection-types.ts";
import type { CalendarFacets, CalendarFilters, CalendarViewMode } from "./calendar-projections.ts";

/**
 * The stable screen-to-workspace snapshot. Layout, menus, and overlays are
 * deliberately absent: the controller supplies a projection and the screen
 * supplies intent callbacks.
 */
export interface CalendarWorkspaceModel {
  readonly view: CalendarViewMode;
  readonly selectedView?: CalendarViewMode;
  readonly anchorDate: string;
  readonly selectedDate?: string;
  readonly filters?: CalendarFilters;
  readonly facets?: CalendarFacetSource | CalendarFacets;
  readonly projection?: CalendarViewProjection | null;
  readonly loading?: boolean;
  readonly refreshing?: boolean;
  readonly emptyLabel?: string;
  readonly resultCount?: number;
  readonly liveAnnouncement?: string;
}

/** Canonical workspace intents. Compatibility callback aliases stay at the adapter boundary. */
export interface CalendarWorkspaceActions
  extends Pick<CalendarCanvasCallbacks, "onSelectDate" | "onSelectMonth" | "onOpenEvent" | "onOpenOverflow"> {
  readonly onFiltersChange?: (filters: CalendarFilters) => void;
  readonly onClearFilters?: () => void;
  readonly onViewChange?: (view: CalendarViewMode) => void;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onToday?: () => void;
  readonly onDateChange?: (date: string) => void;
  readonly onAddEvent?: () => void;
}

/** Small public composition API used by the route and future embedders. */
export interface CalendarWorkspacePublicProps {
  readonly model: CalendarWorkspaceModel;
  readonly actions?: CalendarWorkspaceActions;
  readonly children?: CalendarCanvasChild;
  readonly renderCanvas?: CalendarCanvasRenderSlot;
  readonly canvas?: CalendarCanvasChild;
  readonly weekStartsOn?: 0 | 1;
  readonly locale?: string;
  readonly addEventLabel?: string;
  readonly addEventDisabled?: boolean;
  readonly className?: string;
}

/** Route/container options; controller and overlay state stay private to CalendarView. */
export interface CalendarViewProps {
  readonly api?: CalendarApi;
  readonly token?: string;
  readonly capabilities?: CalendarAccessCapabilities;
  readonly accountId?: string;
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
}

export type { CalendarFacets, CalendarFilters, CalendarViewMode };
export type { CalendarCanvasCallbacks, CalendarCanvasChild, CalendarCanvasRenderSlot };
export type { CalendarFacetSource, CalendarViewProjection, CalendarAccessCapabilities };
