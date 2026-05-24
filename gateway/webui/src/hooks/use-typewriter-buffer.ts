import { type Signal, useSignal } from "@preact/signals";
import { createLogger } from "@sentient/web-sdk";
import { useCallback, useEffect, useRef } from "preact/hooks";
import { TYPEWRITER } from "../config/typewriter.ts";

const log = createLogger(["sentient", "webui", "typewriter"]);

function isSentenceBoundary(c: string | undefined, next: string | undefined): boolean {
  if (c !== "." && c !== "!" && c !== "?") return false;
  // Trailing boundary (end of buffer so far) OR followed by whitespace.
  if (next === undefined) return true;
  return next === " " || next === "\n" || next === "\t";
}

function isParagraphBoundary(c: string | undefined, prev: string | undefined): boolean {
  return c === "\n" && prev === "\n";
}

function applySemanticPause(buffer: string, visiblePos: number, now: number, pauseUntilRef: { current: number }): void {
  const lastChar = buffer[visiblePos - 1];
  const nextChar = buffer[visiblePos];
  const prevChar = buffer[visiblePos - 2];
  if (isParagraphBoundary(lastChar, prevChar)) {
    pauseUntilRef.current = now + TYPEWRITER.paragraphPauseMs;
    log.debug("pause-paragraph", { at: visiblePos, untilMs: pauseUntilRef.current });
  } else if (isSentenceBoundary(lastChar, nextChar)) {
    pauseUntilRef.current = now + TYPEWRITER.sentencePauseMs;
    log.debug("pause-sentence", { at: visiblePos, untilMs: pauseUntilRef.current });
  }
}

export interface UseTypewriterBufferResult {
  readonly visible: Signal<string>;
  setBuffer: (text: string) => void;
  markComplete: () => void;
  reset: () => void;
}

export function useTypewriterBuffer(): UseTypewriterBufferResult {
  const visible = useSignal("");
  const bufferRef = useRef("");
  const visiblePosRef = useRef(0);
  const streamCompleteRef = useRef(false);
  const lastTickTsRef = useRef(0);
  const pauseUntilRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);

  const cancelScheduled = useCallback((): void => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  function schedule(): void {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    rafIdRef.current = null;

    // Catch-up path: visible has reached buffer end.
    if (visiblePosRef.current >= bufferRef.current.length) {
      if (streamCompleteRef.current) {
        lastTickTsRef.current = 0;
        log.debug("tick-drain-complete", { final: bufferRef.current.length });
        return;
      }
      // Stream still live — keep loop alive cheaply.
      lastTickTsRef.current = now;
      schedule();
      return;
    }

    // Pause gate (Phase 2).
    if (now < pauseUntilRef.current) {
      lastTickTsRef.current = now;
      schedule();
      return;
    }

    if (lastTickTsRef.current === 0) lastTickTsRef.current = now;
    const dt = (now - lastTickTsRef.current) / 1000;
    lastTickTsRef.current = now;

    const gap = bufferRef.current.length - visiblePosRef.current;
    const rawRate = streamCompleteRef.current
      ? TYPEWRITER.maxRate
      : TYPEWRITER.baseRate * (1 + gap * TYPEWRITER.gapGain);
    const rate = Math.max(TYPEWRITER.minRate, Math.min(TYPEWRITER.maxRate, rawRate));

    const advance = Math.max(1, Math.floor(rate * dt));
    visiblePosRef.current = Math.min(bufferRef.current.length, visiblePosRef.current + advance);
    visible.value = bufferRef.current.slice(0, visiblePosRef.current);

    applySemanticPause(bufferRef.current, visiblePosRef.current, now, pauseUntilRef);

    schedule();
  }

  function setBuffer(text: string): void {
    if (text.length <= bufferRef.current.length) {
      // Never shrink. Shorter text on the same cycle is a caller bug — log and ignore.
      if (text.length < bufferRef.current.length) {
        log.warn("setBuffer-shrink-ignored", {
          reason: "buffer-append-only",
          prev: bufferRef.current.length,
          next: text.length,
        });
      }
      return;
    }
    bufferRef.current = text;
    log.debug("setBuffer", { bufferLen: text.length, visiblePos: visiblePosRef.current });
    schedule();
  }

  function markComplete(): void {
    if (streamCompleteRef.current) return;
    streamCompleteRef.current = true;
    log.debug("markComplete", { bufferLen: bufferRef.current.length, visiblePos: visiblePosRef.current });
    schedule();
  }

  function reset(): void {
    cancelScheduled();
    bufferRef.current = "";
    visiblePosRef.current = 0;
    streamCompleteRef.current = false;
    lastTickTsRef.current = 0;
    pauseUntilRef.current = 0;
    visible.value = "";
    log.debug("reset", {});
  }

  useEffect(() => {
    return () => {
      cancelScheduled();
    };
  }, [cancelScheduled]);

  return { visible, setBuffer, markComplete, reset };
}
