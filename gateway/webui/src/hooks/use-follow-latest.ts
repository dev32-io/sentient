import type { RefObject } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export interface UseFollowLatestArgs {
  scrollContainerRef: RefObject<HTMLElement>;
  contentRef: RefObject<HTMLElement>;
  /** Pixels from the bottom within which we consider the user "at the bottom". */
  bottomSnapPx?: number;
}

export interface UseFollowLatestReturn {
  readonly pinToBottom: boolean;
  anchorTo(resolveTop: () => number, smooth: boolean): void;
  cancelAnchor(): void;
  releaseAnchor(resetScrollTop?: number): void;
  jumpToLatest(): void;
}

// Small tolerance for fractional scroll positions. Anything within this is
// treated as "not a direction change" so browser sub-pixel jitter doesn't
// flip pin state.
const DIRECTION_EPSILON_PX = 1;
const OWNED_ANCHOR_DURATION_MS = 250;

// Terminal-log semantics:
//   - The user is "pinned" when their scroll position is within
//     `bottomSnapPx` of the max (the end of content).
//   - Only *actual user scroll-up* (scrollTop decreased) flips pin OFF. The
//     naive "distFromBottom > snap" test doesn't work on its own because
//     streaming tokens grow scrollHeight between our scrollTo and the
//     scroll event it produces — for a frame, distFromBottom looks like
//     "user scrolled up" when really the content just outpaced us. Using
//     scrollTop-direction as the unpin signal eliminates that race.
//   - Coming back within the snap zone re-pins.
//   - When pinned, any content resize (ResizeObserver) re-issues a scroll
//     to max so we stay at the bottom as tokens arrive.
export function useFollowLatest({
  scrollContainerRef,
  contentRef,
  bottomSnapPx = 8,
}: UseFollowLatestArgs): UseFollowLatestReturn {
  const [pinToBottom, setPinToBottom] = useState(true);
  const pinRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const anchorRef = useRef<(() => number) | null>(null);
  const anchorFrameRef = useRef<number | null>(null);

  const cancelAnchorAnimation = useCallback(() => {
    if (anchorFrameRef.current === null) return;
    cancelAnimationFrame(anchorFrameRef.current);
    anchorFrameRef.current = null;
  }, []);

  const scrollImmediately = useCallback((el: HTMLElement, top: number) => {
    try {
      el.scrollTo({ top, behavior: "auto" });
    } catch {
      el.scrollTop = top;
    }
  }, []);

  const scrollToMax = useCallback((el: HTMLElement, smooth: boolean) => {
    const top = el.scrollHeight - el.clientHeight;
    if (top <= 0) return;
    try {
      el.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    } catch {
      el.scrollTop = top;
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    scrollToMax(el, false);
  }, [scrollContainerRef, scrollToMax]);

  const cancelAnchor = useCallback(() => {
    anchorRef.current = null;
    cancelAnchorAnimation();
  }, [cancelAnchorAnimation]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable]")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelAnchor();
    };
    const onScroll = () => {
      const top = el.scrollTop;
      const h = el.scrollHeight;
      const shrank = h < lastScrollHeightRef.current;
      const prevTop = lastScrollTopRef.current;
      lastScrollTopRef.current = top;
      lastScrollHeightRef.current = h;

      // Owned send placement is released only by manual input or a newer send.
      // Programmatic animation events must not re-pin to the tail.
      if (anchorRef.current) return;

      // When the content shrinks (e.g., inflight bubble → committed bubble
      // swap), the browser clamps scrollTop to (scrollHeight - clientHeight).
      // That clamped scrollTop decrease looks like a user scroll-up but
      // isn't one. Skip unpin evaluation; ResizeObserver will re-pin once
      // content grows back.
      if (shrank && pinRef.current) return;

      const movedUp = top < prevTop - DIRECTION_EPSILON_PX;
      const dist = h - top - el.clientHeight;
      const atBottom = dist <= bottomSnapPx;

      // Unpin only on real user scroll-up (scrollTop decreased, height
      // stable or growing) that lands outside the snap zone.
      if (pinRef.current && movedUp && !atBottom) {
        pinRef.current = false;
        setPinToBottom(false);
        return;
      }
      // Re-pin whenever we're back in the snap zone.
      if (!pinRef.current && atBottom) {
        pinRef.current = true;
        setPinToBottom(true);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", cancelAnchor, { passive: true });
    el.addEventListener("touchstart", cancelAnchor, { passive: true });
    el.addEventListener("pointerdown", cancelAnchor, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", cancelAnchor);
      el.removeEventListener("touchstart", cancelAnchor);
      el.removeEventListener("pointerdown", cancelAnchor);
      document.removeEventListener("keydown", onKeyDown);
      cancelAnchorAnimation();
    };
  }, [scrollContainerRef, bottomSnapPx, cancelAnchor, cancelAnchorAnimation]);

  useEffect(() => {
    const content = contentRef.current;
    const el = scrollContainerRef.current;
    if (!content || !el) return;
    if (typeof ResizeObserver === "undefined") return;

    // Include content padding: floating dock clearance changes the border box,
    // not the default content box. Streaming and viewport changes also realign
    // the owned send, or follow the bottom while pinned.
    const ro = new ResizeObserver(() => {
      const resolveTop = anchorRef.current;
      if (resolveTop) {
        const top = Math.max(0, resolveTop());
        if (anchorFrameRef.current === null && Math.abs(el.scrollTop - top) > DIRECTION_EPSILON_PX)
          scrollImmediately(el, top);
        return;
      }
      if (pinRef.current) scrollToMax(el, false);
    });
    ro.observe(content, { box: "border-box" });
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentRef, scrollContainerRef, scrollImmediately, scrollToMax]);

  const anchorTo = useCallback(
    (resolveTop: () => number, smooth: boolean) => {
      const el = scrollContainerRef.current;
      if (!el) return;
      cancelAnchorAnimation();
      anchorRef.current = resolveTop;
      pinRef.current = false;
      setPinToBottom(false);
      const startTop = el.scrollTop;
      const top = Math.max(0, resolveTop());
      if (!smooth || Math.abs(startTop - top) <= DIRECTION_EPSILON_PX) {
        scrollImmediately(el, top);
        return;
      }

      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / OWNED_ANCHOR_DURATION_MS);
        const eased = (1 - Math.cos(Math.PI * progress)) / 2;
        const destination = Math.max(0, resolveTop());
        scrollImmediately(el, startTop + (destination - startTop) * eased);
        if (progress < 1) anchorFrameRef.current = requestAnimationFrame(tick);
        else anchorFrameRef.current = null;
      };
      anchorFrameRef.current = requestAnimationFrame(tick);
    },
    [cancelAnchorAnimation, scrollContainerRef, scrollImmediately],
  );

  const releaseAnchor = useCallback(
    (resetScrollTop?: number) => {
      const el = scrollContainerRef.current;
      anchorRef.current = null;
      cancelAnchorAnimation();
      if (el && resetScrollTop !== undefined) {
        el.scrollTop = resetScrollTop;
        lastScrollTopRef.current = el.scrollTop;
        lastScrollHeightRef.current = el.scrollHeight;
      }
      pinRef.current = true;
      setPinToBottom(true);
    },
    [cancelAnchorAnimation, scrollContainerRef],
  );

  const jumpToLatest = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    anchorRef.current = null;
    cancelAnchorAnimation();
    pinRef.current = true;
    setPinToBottom(true);
    scrollToMax(el, true);
  }, [cancelAnchorAnimation, scrollContainerRef, scrollToMax]);

  return { pinToBottom, anchorTo, cancelAnchor, releaseAnchor, jumpToLatest };
}
