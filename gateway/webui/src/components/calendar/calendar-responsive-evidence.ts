/**
 * Browser-side measurement used by the reviewed calendar visual evidence.
 * This is intentionally observational: it never changes layout or owns view
 * state, and it keeps the no-overflow/target-size assertions at the canvas
 * boundary where the CSS contract is visible.
 */
export interface CalendarResponsiveEvidence {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly documentScrollWidth: number;
  readonly bodyScrollWidth: number;
  readonly documentClientWidth: number;
  readonly canvasScrollWidth: number | null;
  readonly canvasClientWidth: number | null;
  readonly gridScrollWidth: number | null;
  readonly gridClientWidth: number | null;
  readonly sevenColumns: boolean;
  readonly noHorizontalOverflow: boolean;
  readonly compactControlsRendered: boolean;
  readonly sidebarRendered: boolean;
  readonly interactiveTargetMinimumCss: 44;
  readonly interactiveTargetCount: number;
  readonly minimumInteractiveTarget: { readonly width: number; readonly height: number } | null;
}

const INTERACTIVE_TARGET_SELECTOR = [
  ".calendar-day-cell__date",
  ".calendar-event-indicator:not(.calendar-event-indicator--visually-hidden)",
  ".calendar-overflow-control",
  ".calendar-year-grid__date",
  ".calendar-year-grid__month-button",
].join(", ");

function visible(element: Element | null, document: Document): boolean {
  if (!element) return false;
  const view = document.defaultView;
  return view === null || view.getComputedStyle(element).display !== "none";
}

/** Measure the served canvas without adding content-bearing diagnostics. */
export function measureCalendarResponsiveEvidence(document: Document): CalendarResponsiveEvidence {
  const view = document.defaultView;
  const canvas = document.querySelector<HTMLElement>("[data-calendar-canvas]");
  const month = document.querySelector<HTMLElement>(".calendar-month-grid");
  const week = document.querySelector<HTMLElement>(".calendar-week-grid");
  const grid = month?.querySelector<HTMLElement>(".calendar-month-grid__grid")
    ?? week?.querySelector<HTMLElement>(".calendar-week-grid__grid");
  const row = month?.querySelector<HTMLElement>(".calendar-month-grid__row") ?? week?.querySelector<HTMLElement>(".calendar-week-grid__grid");
  const columns = row && view
    ? view.getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean).length
    : 0;
  const targets = [...document.querySelectorAll<HTMLElement>(INTERACTIVE_TARGET_SELECTOR)]
    .map((element) => element.getBoundingClientRect());
  const documentElement = document.documentElement;
  const body = document.body;
  const minimumInteractiveTarget = targets.length === 0
    ? null
    : {
        width: Math.min(...targets.map((rect) => rect.width)),
        height: Math.min(...targets.map((rect) => rect.height)),
      };
  const compact = document.querySelector(".calendar-workspace__compact");
  const sidebar = document.querySelector("[data-calendar-filter-sidebar]");
  const viewportWidth = view?.innerWidth ?? documentElement.clientWidth;
  const viewportHeight = view?.innerHeight ?? 0;
  return {
    viewport: { width: viewportWidth, height: viewportHeight },
    documentScrollWidth: documentElement.scrollWidth,
    bodyScrollWidth: body.scrollWidth,
    documentClientWidth: documentElement.clientWidth,
    canvasScrollWidth: canvas?.scrollWidth ?? null,
    canvasClientWidth: canvas?.clientWidth ?? null,
    gridScrollWidth: grid?.scrollWidth ?? null,
    gridClientWidth: grid?.clientWidth ?? null,
    sevenColumns: columns === 7,
    noHorizontalOverflow: documentElement.scrollWidth <= viewportWidth && body.scrollWidth <= viewportWidth,
    compactControlsRendered: visible(compact, document),
    sidebarRendered: visible(sidebar, document),
    interactiveTargetMinimumCss: 44,
    interactiveTargetCount: targets.length,
    minimumInteractiveTarget,
  };
}
