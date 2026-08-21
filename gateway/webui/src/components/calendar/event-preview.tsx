import type { JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createEventPreviewModel,
  type EventPreviewFormatOptions,
  type EventPreviewOccurrence,
} from "./event-preview-details.ts";
import {
  calculateEventPreviewPosition,
  type EventPreviewAnchorRect,
  type EventPreviewPosition,
  type EventPreviewViewport,
} from "./event-preview-position.ts";
import type { ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";
import "./event-preview.css";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export type EventPreviewAnchor = HTMLElement | EventPreviewAnchorRect;

export interface EventPreviewProps {
  /** The effective occurrence to show. `event` and `openOccurrence` are aliases for assembly callers. */
  readonly occurrence?: EventPreviewOccurrence | null;
  readonly event?: EventPreviewOccurrence | null;
  readonly openOccurrence?: EventPreviewOccurrence | null;
  /** When supplied, this controls visibility independently of the occurrence value. */
  readonly open?: boolean;
  /** Anchor element/rect aliases allow canvas callers to choose their natural seam. */
  readonly anchor?: EventPreviewAnchor | null;
  readonly anchorElement?: HTMLElement | null;
  readonly anchorRect?: EventPreviewAnchorRect | DOMRect | null;
  readonly anchorRef?: { readonly current: HTMLElement | null };
  readonly viewport?: EventPreviewViewport;
  readonly viewportMargin?: number;
  readonly gap?: number;
  readonly maxWidth?: number;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly deviceTimeZone?: string;
  readonly timeZoneId?: string;
  readonly id?: string;
  readonly onClose?: () => void;
  /** Callbacks receive the normalized effective row, including stable `action` identity. */
  readonly onEdit?: (occurrence: ProjectedCalendarOccurrence) => void;
  readonly onDelete?: (occurrence: ProjectedCalendarOccurrence) => void;
}

interface EventPreviewStyle {
  readonly left: string;
  readonly top: string;
  readonly width: string;
  readonly maxWidth: string;
  readonly maxHeight: string;
  readonly [property: string]: string;
}

function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);
  return reduced;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function viewportSize(override?: EventPreviewViewport): EventPreviewViewport {
  if (override) return override;
  if (typeof window === "undefined") return { width: 1024, height: 768 };
  const visual = window.visualViewport;
  return {
    width: finiteOr(visual?.width ?? window.innerWidth, document.documentElement.clientWidth || 1024),
    height: finiteOr(visual?.height ?? window.innerHeight, document.documentElement.clientHeight || 768),
  };
}

function isElementAnchor(value: EventPreviewAnchor | null | undefined): value is HTMLElement {
  return Boolean(value && typeof (value as HTMLElement).getBoundingClientRect === "function");
}

function elementForAnchor(
  anchor: EventPreviewAnchor | null | undefined,
  anchorElement: HTMLElement | null | undefined,
  anchorRef: { readonly current: HTMLElement | null } | undefined,
): HTMLElement | null {
  if (anchorElement) return anchorElement;
  if (anchorRef?.current) return anchorRef.current;
  return isElementAnchor(anchor) ? anchor : null;
}

function readRect(element: HTMLElement): EventPreviewAnchorRect | null {
  try {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    };
  } catch {
    return null;
  }
}

function rectForAnchor(
  anchor: EventPreviewAnchor | null | undefined,
  anchorElement: HTMLElement | null,
  anchorRect: EventPreviewAnchorRect | DOMRect | null | undefined,
  origin: HTMLElement | null,
  margin: number,
): EventPreviewAnchorRect {
  if (anchorRect) return anchorRect;
  if (anchorElement) {
    const rect = readRect(anchorElement);
    if (rect) return rect;
  }
  if (!anchorElement && isElementAnchor(anchor)) {
    const rect = readRect(anchor);
    if (rect) return rect;
  }
  if (anchor && !isElementAnchor(anchor)) return anchor;
  if (origin) {
    const rect = readRect(origin);
    if (rect) return rect;
  }
  return { left: margin, top: margin, width: 0, height: 0, right: margin, bottom: margin };
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function setTriggerExpanded(element: HTMLElement | null, expanded: boolean, id: string): void {
  if (!element) return;
  element.setAttribute("aria-haspopup", "dialog");
  element.setAttribute("aria-expanded", String(expanded));
  if (expanded) element.setAttribute("aria-controls", id);
  else element.removeAttribute("aria-controls");
}

function isInside(target: EventTarget | null, root: HTMLElement | null): boolean {
  if (!root || !target || typeof (target as Node).nodeType !== "number") return false;
  return root.contains(target as Node);
}

export function EventPreview({
  occurrence,
  event,
  openOccurrence,
  open,
  anchor,
  anchorElement,
  anchorRect,
  anchorRef,
  viewport,
  viewportMargin = 12,
  gap = 12,
  maxWidth = 320,
  locale,
  timeZone,
  deviceTimeZone,
  timeZoneId,
  id = "calendar-event-preview",
  onClose,
  onEdit,
  onDelete,
}: EventPreviewProps): JSX.Element | null {
  const selected = occurrence ?? openOccurrence ?? event ?? null;
  const isOpen = selected !== null && (open ?? true);
  const formatOptions: EventPreviewFormatOptions = {
    ...(locale !== undefined ? { locale } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(deviceTimeZone !== undefined ? { deviceTimeZone } : {}),
    ...(timeZoneId !== undefined ? { timeZoneId } : {}),
  };
  const model = useMemo(
    () => {
      if (!selected) return null;
      try {
        return createEventPreviewModel(selected, formatOptions);
      } catch {
        return null;
      }
    },
    // The selected occurrence is the authoritative input; format settings are
    // explicit dependencies so a device-zone change recomputes its labels.
    [selected, locale, timeZone, deviceTimeZone, timeZoneId],
  );
  const previewRef = useRef<HTMLElement | null>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const activeAnchorRef = useRef<HTMLElement | null>(null);
  const openKeyRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const dismissedRef = useRef(false);
  const [position, setPosition] = useState<EventPreviewPosition | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const resolvedAnchorElement = elementForAnchor(anchor, anchorElement, anchorRef);
  const occurrenceKey = model?.occurrence.action.occurrenceId ?? model?.occurrence.eventId ?? null;

  const restoreOrigin = useCallback((): void => {
    const origin = originRef.current;
    originRef.current = null;
    activeAnchorRef.current = null;
    if (!origin) return;
    if (origin.isConnected === false) return;
    origin.focus();
  }, []);

  const requestClose = useCallback((): void => {
    if (!isOpen || dismissedRef.current) return;
    dismissedRef.current = true;
    setTriggerExpanded(activeAnchorRef.current ?? resolvedAnchorElement, false, id);
    restoreOrigin();
    onClose?.();
  }, [id, isOpen, onClose, resolvedAnchorElement, restoreOrigin]);

  useLayoutEffect(() => {
    if (!isOpen || !model) return;
    const isNewOpen = !wasOpenRef.current || openKeyRef.current !== occurrenceKey;
    if (isNewOpen) {
      setTriggerExpanded(activeAnchorRef.current, false, id);
      dismissedRef.current = false;
      const origin = resolvedAnchorElement ?? (document.activeElement as HTMLElement | null);
      originRef.current = origin && typeof origin.focus === "function" ? origin : null;
      activeAnchorRef.current = resolvedAnchorElement ?? originRef.current;
      openKeyRef.current = occurrenceKey;
    }
    wasOpenRef.current = true;
    setTriggerExpanded(activeAnchorRef.current, true, id);
    const root = previewRef.current;
    const initial = root?.querySelector<HTMLElement>("[data-event-preview-initial-focus]") ?? root;
    initial?.focus();
  }, [id, isOpen, model, occurrenceKey, resolvedAnchorElement]);

  useEffect(() => {
    if (isOpen) return;
    setTriggerExpanded(activeAnchorRef.current ?? resolvedAnchorElement, false, id);
    if (wasOpenRef.current) restoreOrigin();
    wasOpenRef.current = false;
    openKeyRef.current = null;
    dismissedRef.current = false;
    setPosition(null);
  }, [id, isOpen, resolvedAnchorElement, restoreOrigin]);

  useEffect(() => {
    return () => {
      if (wasOpenRef.current) {
        setTriggerExpanded(activeAnchorRef.current, false, id);
        restoreOrigin();
      }
    };
  }, [id, restoreOrigin]);

  useEffect(() => {
    if (!isOpen || !model) return undefined;
    const root = previewRef.current;
    if (!root) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableElements(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      event.stopPropagation();
      if (!root.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, model, requestClose]);

  useEffect(() => {
    if (!isOpen || !model) return undefined;
    const onOutside = (event: Event): void => {
      if (dismissedRef.current) return;
      if (isInside(event.target, previewRef.current)) return;
      const targetAnchor = activeAnchorRef.current ?? resolvedAnchorElement;
      if (isInside(event.target, targetAnchor)) return;
      if (event.type === "pointerdown" || event.type === "mousedown") event.preventDefault();
      requestClose();
    };
    // Pointerdown closes before focus can escape; mousedown/click keep the
    // behavior deterministic in browsers and jsdom environments without
    // PointerEvent support.
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("click", onOutside, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("click", onOutside, true);
    };
  }, [isOpen, model, requestClose, resolvedAnchorElement]);

  useLayoutEffect(() => {
    if (!isOpen || !model) {
      setPosition(null);
      return undefined;
    }
    const root = previewRef.current;
    if (!root) return undefined;
    const margin = Math.max(0, Number.isFinite(viewportMargin) ? viewportMargin : 12);
    const preferredWidth = Math.max(0, Number.isFinite(maxWidth) ? maxWidth : 320);
    const update = (): void => {
      const currentViewport = viewportSize(viewport);
      const availableWidth = Math.max(0, currentViewport.width - margin * 2);
      const availableHeight = Math.max(0, currentViewport.height - margin * 2);
      const measured = root.getBoundingClientRect();
      const measuredWidth = finiteOr(measured.width, Math.min(preferredWidth, availableWidth));
      const measuredHeight = Math.min(
        finiteOr(measured.height, finiteOr(root.scrollHeight, Math.min(420, availableHeight))),
        availableHeight,
      );
      const next = calculateEventPreviewPosition(
        rectForAnchor(anchor, resolvedAnchorElement, anchorRect, originRef.current, margin),
        currentViewport,
        { width: Math.min(measuredWidth, preferredWidth), height: measuredHeight },
        { margin, gap, maxHeight: availableHeight },
      );
      setPosition(next);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const visual = window.visualViewport;
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    resizeObserver?.observe(root);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      resizeObserver?.disconnect();
    };
  }, [anchor, anchorRect, gap, isOpen, maxWidth, model, resolvedAnchorElement, viewport, viewportMargin]);

  const invokeAction = useCallback(
    (callback: ((value: ProjectedCalendarOccurrence) => void) | undefined): void => {
      if (!callback || !model) return;
      const effective = model.occurrence;
      requestClose();
      callback(effective);
    },
    [model, requestClose],
  );

  if (!isOpen || !model) return null;

  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const when = model.details.find((item) => item.key === "when")?.value ?? "";
  const detailRows = model.details.filter((item) => item.key !== "when");
  const placement = position?.placement ?? "right";
  const placementClass = placement === "right" ? "side-right" : placement === "left" ? "side-left" : "below";
  const style: EventPreviewStyle = {
    left: `${position?.left ?? Math.max(0, viewportMargin)}px`,
    top: `${position?.top ?? Math.max(0, viewportMargin)}px`,
    width: `${position?.width ?? Math.min(maxWidth, Math.max(0, viewportSize(viewport).width - viewportMargin * 2))}px`,
    maxWidth: `calc(100vw - ${viewportMargin * 2}px)`,
    maxHeight: `${position?.maxHeight ?? Math.max(0, viewportSize(viewport).height - viewportMargin * 2)}px`,
    "--event-preview-arrow-x": `${position?.arrowX ?? 40}px`,
    "--event-preview-arrow-y": `${position?.arrowY ?? 40}px`,
  };

  return (
    <aside
      ref={previewRef}
      id={id}
      class={`event-preview event-preview--${placement} ${placementClass}`}
      role="dialog"
      aria-modal="true"
      aria-hidden="false"
      aria-labelledby={titleId}
      {...(model.description ? { "aria-describedby": descriptionId } : {})}
      aria-live="polite"
      data-event-preview="true"
      data-od-id="calendar-event-preview"
      data-open="true"
      data-placement={placement}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-event-id={model.occurrence.action.eventId}
      data-occurrence-id={model.occurrence.action.occurrenceId}
      data-original-start={model.occurrence.action.originalStart}
      data-scope={model.occurrence.action.scope}
      {...(model.occurrence.action.revision !== undefined
        ? { "data-revision": String(model.occurrence.action.revision) }
        : {})}
      style={style}
      tabIndex={-1}
    >
      <div class="event-preview__hero" aria-hidden="true" />
      <div class="event-preview__body" data-scrollable="true">
        <button
          type="button"
          class="event-preview__close"
          aria-label="Close event details"
          data-od-id="calendar-event-preview-close"
          data-event-preview-initial-focus="true"
          onClick={requestClose}
        />
        <p class="event-preview__kicker">Event preview</p>
        <h2 class="event-preview__title" id={titleId}>{model.occurrence.title || "Event details"}</h2>
        <p class="event-preview__time" aria-label={`When: ${when}`}><span class="event-preview__sr-only">When: </span>{when}</p>
        {model.description && <p class="event-preview__description" id={descriptionId}>{model.description}</p>}
        <dl class="event-preview__meta">
          {detailRows.map((item) => (
            <div class="event-preview__detail" data-detail-key={item.key} key={item.key}>
              <dt>{item.label}</dt>
              <dd>
                {item.key === "tags" ? (
                  <span class="event-preview__tags">
                    {model.occurrence.tags.map((tag) => <span class="event-preview__tag" key={tag}>{tag}</span>)}
                  </span>
                ) : item.value}
              </dd>
            </div>
          ))}
        </dl>
        <div class="event-preview__actions">
          <button
            type="button"
            class="event-preview__action event-preview__action--edit"
            disabled={!onEdit}
            onClick={() => invokeAction(onEdit)}
          >
            Edit
          </button>
          <button
            type="button"
            class="event-preview__action event-preview__action--delete"
            disabled={!onDelete}
            onClick={() => invokeAction(onDelete)}
          >
            Delete
          </button>
        </div>
      </div>
    </aside>
  );
}

export {
  calculateEventPreviewPosition,
  getEventPreviewPosition,
  positionEventPreview,
} from "./event-preview-position.ts";
export {
  createEventPreviewModel,
  eventPreviewDetails,
  formatEventPreviewTime,
  mapEventPreviewDetails,
} from "./event-preview-details.ts";
export type {
  EventPreviewDetail,
  EventPreviewFormatOptions,
  EventPreviewModel,
  EventPreviewOccurrence,
} from "./event-preview-details.ts";
export type {
  EventPreviewAnchorRect,
  EventPreviewPopoverSize,
  EventPreviewPosition,
  EventPreviewPositionOptions,
  EventPreviewPlacement,
  EventPreviewViewport,
} from "./event-preview-position.ts";

export default EventPreview;
