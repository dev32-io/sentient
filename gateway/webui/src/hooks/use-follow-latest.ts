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
  jumpToLatest(): void;
}

// Small tolerance for fractional scroll positions. Anything within this is
// treated as "not a direction change" so browser sub-pixel jitter doesn't
// flip pin state.
const DIRECTION_EPSILON_PX = 1;

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

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const onScroll = () => {
      const top = el.scrollTop;
      const h = el.scrollHeight;
      const shrank = h < lastScrollHeightRef.current;
      const prevTop = lastScrollTopRef.current;
      lastScrollTopRef.current = top;
      lastScrollHeightRef.current = h;

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
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, bottomSnapPx]);

  useEffect(() => {
    const content = contentRef.current;
    const el = scrollContainerRef.current;
    if (!content || !el) return;
    if (typeof ResizeObserver === "undefined") return;

    // Observe both the content (grows during streaming) and the scroll
    // container itself (shrinks/grows on viewport resize and when the
    // dock-clearance padding-bottom updates). Either kind of resize needs
    // to re-scroll to max while pinned.
    const ro = new ResizeObserver(() => {
      if (!pinRef.current) return;
      scrollToMax(el, false);
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentRef, scrollContainerRef, scrollToMax]);

  const jumpToLatest = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    pinRef.current = true;
    setPinToBottom(true);
    scrollToMax(el, true);
  }, [scrollContainerRef, scrollToMax]);

  return { pinToBottom, jumpToLatest };
}
