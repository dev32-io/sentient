export type EventPreviewPlacement = "right" | "left" | "below";

/** The rectangle shape returned by getBoundingClientRect, kept testable without a DOM. */
export interface EventPreviewAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right?: number;
  readonly bottom?: number;
}

export interface EventPreviewViewport {
  readonly width: number;
  readonly height: number;
}

export interface EventPreviewPopoverSize {
  readonly width: number;
  readonly height: number;
}

export interface EventPreviewPositionOptions {
  /** Minimum distance from every viewport edge. */
  readonly margin?: number;
  /** Gap between the anchor and the popover. */
  readonly gap?: number;
  /** Maximum height before the preview body becomes scrollable. */
  readonly maxHeight?: number;
}

export interface EventPreviewPosition {
  readonly placement: EventPreviewPlacement;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly maxHeight: number;
  /** Arrow coordinates are relative to the popover's own box. */
  readonly arrowX: number;
  readonly arrowY: number;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number, fallback: number): number {
  return Math.max(0, finite(value, fallback));
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function arrowCoordinate(value: number, size: number): number {
  const minimum = Math.min(20, Math.max(0, size));
  const maximum = Math.max(minimum, size - minimum);
  return clamp(value, minimum, maximum);
}

function rectEdges(anchor: EventPreviewAnchorRect): { right: number; bottom: number } {
  return {
    right: finite(anchor.right ?? Number.NaN, anchor.left + anchor.width),
    bottom: finite(anchor.bottom ?? Number.NaN, anchor.top + anchor.height),
  };
}

/**
 * Choose the reference placement order (right, left, below), then clamp both
 * axes to the reachable viewport. The returned dimensions already account for
 * narrow viewports, so callers can apply them before measuring/rendering.
 */
export function calculateEventPreviewPosition(
  anchor: EventPreviewAnchorRect,
  viewport: EventPreviewViewport,
  popover: EventPreviewPopoverSize,
  options: EventPreviewPositionOptions = {},
): EventPreviewPosition {
  const margin = nonNegative(options.margin ?? 12, 12);
  const gap = nonNegative(options.gap ?? 12, 12);
  const viewportWidth = nonNegative(viewport.width, 0);
  const viewportHeight = nonNegative(viewport.height, 0);
  const availableWidth = Math.max(0, viewportWidth - margin * 2);
  const maxHeight = Math.min(
    nonNegative(options.maxHeight ?? viewportHeight - margin * 2, viewportHeight),
    Math.max(0, viewportHeight - margin * 2),
  );
  const width = Math.min(nonNegative(popover.width, availableWidth), availableWidth);
  const height = Math.min(nonNegative(popover.height, maxHeight), maxHeight);
  const leftEdge = finite(anchor.left, margin);
  const topEdge = finite(anchor.top, margin);
  const { right: rightEdge, bottom: bottomEdge } = rectEdges({
    ...anchor,
    left: leftEdge,
    top: topEdge,
    width: nonNegative(anchor.width, 0),
    height: nonNegative(anchor.height, 0),
  });
  const rightLeft = rightEdge + gap;
  const leftLeft = leftEdge - width - gap;
  const fitsRight = rightLeft + width <= viewportWidth - margin;
  const fitsLeft = leftLeft >= margin;

  let placement: EventPreviewPlacement;
  let rawLeft: number;
  let rawTop: number;
  if (fitsRight) {
    placement = "right";
    rawLeft = rightLeft;
    rawTop = topEdge + (nonNegative(anchor.height, 0) - height) / 2;
  } else if (fitsLeft) {
    placement = "left";
    rawLeft = leftLeft;
    rawTop = topEdge + (nonNegative(anchor.height, 0) - height) / 2;
  } else {
    placement = "below";
    rawLeft = leftEdge;
    rawTop = bottomEdge + gap;
  }

  const maxLeft = Math.max(margin, viewportWidth - margin - width);
  const maxTop = Math.max(margin, viewportHeight - margin - height);
  const left = clamp(rawLeft, margin, maxLeft);
  const top = clamp(rawTop, margin, maxTop);
  const anchorCenterX = leftEdge + nonNegative(anchor.width, 0) / 2;
  const anchorCenterY = topEdge + nonNegative(anchor.height, 0) / 2;

  return {
    placement,
    left,
    top,
    width,
    height,
    maxHeight,
    arrowX: arrowCoordinate(anchorCenterX - left, width),
    arrowY: arrowCoordinate(anchorCenterY - top, height),
  };
}

/** Compatibility aliases for calendar callers that prefer verb-first naming. */
export const positionEventPreview = calculateEventPreviewPosition;
export const getEventPreviewPosition = calculateEventPreviewPosition;
