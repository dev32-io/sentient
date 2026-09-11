import type { JSX } from "preact";
import { ActionButton } from "../common/index.ts";

export function CalendarPermissionState({ reason }: { readonly reason: "signin" | "calendar" }): JSX.Element {
  return (
    <section class="calendar-route-state calendar-route-state--permission" data-calendar-permission-state={reason} aria-labelledby="calendar-permission-title">
      <div class="calendar-route-state__card">
        <p class="calendar-route-state__eyebrow">Calendar</p>
        <h1 id="calendar-permission-title">{reason === "signin" ? "Sign in to view Calendar" : "Calendar access unavailable"}</h1>
        <p>{reason === "signin" ? "Authenticate to see the calendars available to your account." : "This account cannot view the calendar right now."}</p>
      </div>
    </section>
  );
}

export function CalendarLoadingState(): JSX.Element {
  return (
    <section class="calendar-route-state" data-calendar-route-loading aria-busy="true" aria-labelledby="calendar-loading-title">
      <div class="calendar-route-state__card" role="status">
        <p class="calendar-route-state__eyebrow">Calendar</p>
        <h1 id="calendar-loading-title">Loading calendar</h1>
        <p>Preparing your authorized calendar view.</p>
      </div>
    </section>
  );
}

export interface CalendarRouteNoticeProps {
  readonly errorCode: string | null;
  readonly hasData: boolean;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly canEdit: boolean;
  readonly mutationNotice: string | null;
  readonly successorEventId: string | null;
  readonly onRetry: () => void;
}

export function CalendarRouteNotice({
  errorCode,
  hasData,
  canEdit,
  mutationNotice,
  successorEventId,
  onRetry,
}: CalendarRouteNoticeProps): JSX.Element | null {
  // Refreshing/stale are controller freshness signals, not in-flow notices.
  // The workspace exposes aria-busy and retains complete data; only an actual
  // failure needs a persistent saved-data notice and retry action.
  const notices: JSX.Element[] = [];
  if (errorCode && hasData) {
    notices.push(
      <div class="calendar-route-notice calendar-route-notice--stale" role="status" key="stale" data-calendar-state="stale">
        <span>Showing the last saved calendar data.</span>
        <ActionButton onClick={onRetry}>Try again</ActionButton>
      </div>,
    );
  }

  if (!hasData && errorCode && errorCode !== "forbidden") {
    notices.push(
      <div class="calendar-route-notice calendar-route-notice--error" role="alert" key="error" data-calendar-state="error">
        <span>Calendar could not be loaded.</span>
        <ActionButton onClick={onRetry}>Retry</ActionButton>
      </div>,
    );
  }
  if (!canEdit) {
    notices.push(
      <div class="calendar-route-notice calendar-route-notice--permission" role="status" key="permission" data-calendar-state="permission">
        Calendar editing is unavailable for this session.
      </div>,
    );
  }
  if (mutationNotice) {
    notices.push(
      <div
        class="calendar-route-notice calendar-route-notice--success"
        role="status"
        key="mutation"
        data-calendar-state="mutation-success"
        {...(successorEventId === null ? {} : { "data-successor-event-id": successorEventId })}
      >
        {mutationNotice}
      </div>,
    );
  }
  if (notices.length === 0) return null;
  return <div class="calendar-route-notices" aria-live="polite">{notices}</div>;
}
