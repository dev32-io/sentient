import { useEffect, useMemo, useState } from "preact/hooks";
import {
  CalendarController,
  createCalendarController,
  type CalendarControllerActions,
  type CalendarControllerOptions,
  type CalendarControllerSnapshot,
} from "../components/calendar/calendar-controller.ts";

export interface UseCalendarControllerResult extends CalendarControllerSnapshot {
  readonly state: CalendarControllerSnapshot;
  readonly actions: CalendarControllerActions;
  readonly controller: CalendarController;
}

/**
 * Preact adapter for the transport-injected CalendarController. The hook owns
 * subscription lifetime only; event-editor drafts and route assembly remain
 * outside this state surface.
 */
export function useCalendarController(options: CalendarControllerOptions): UseCalendarControllerResult {
  const {
    api,
    token,
    accountId,
    userId,
    backendId,
    backendUrl,
    baseUrl,
    preferenceStore,
    initialView,
    initialAnchorDate,
    initialDate,
    initialFilters,
    now,
    weekStartsOn,
    projections,
  } = options;
  const controller = useMemo(
    () => createCalendarController({
      api,
      token,
      ...(accountId !== undefined ? { accountId } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ...(backendId !== undefined ? { backendId } : {}),
      ...(backendUrl !== undefined ? { backendUrl } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(preferenceStore !== undefined ? { preferenceStore } : {}),
      ...(initialView !== undefined ? { initialView } : {}),
      ...(initialAnchorDate !== undefined ? { initialAnchorDate } : {}),
      ...(initialDate !== undefined ? { initialDate } : {}),
      ...(initialFilters !== undefined ? { initialFilters } : {}),
      ...(now !== undefined ? { now } : {}),
      ...(weekStartsOn !== undefined ? { weekStartsOn } : {}),
      ...(projections !== undefined ? { projections } : {}),
    }),
    [
      api,
      token,
      accountId,
      userId,
      backendId,
      backendUrl,
      baseUrl,
      preferenceStore,
      initialView,
      initialAnchorDate,
      initialDate,
      initialFilters,
      now,
      weekStartsOn,
      projections,
    ],
  );
  const [state, setState] = useState<CalendarControllerSnapshot>(() => controller.state);

  useEffect(() => {
    setState(controller.state);
    return controller.subscribe(setState);
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    controller.setAddEventOpener(options.onAddEvent);
  }, [controller, options.onAddEvent]);

  const actions = controller.actions;
  return { ...state, state, actions, controller };
}

export type { CalendarControllerOptions };