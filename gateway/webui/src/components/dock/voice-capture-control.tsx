import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type CapturePort,
  type LegacyCaptureMode,
  type LegacyCaptureSource,
  createCapturePort,
} from "./capture-adapter.ts";
import { ComposerGlyph } from "./composer-glyph.tsx";
import {
  type VoiceCaptureState,
  type VoiceCaptureTarget,
  mapVoiceCapturePresentation,
  targetLabel,
} from "./voice-capture-state.ts";

export type { VoiceCaptureMode, VoiceCaptureState } from "./voice-capture-state.ts";

interface InternalVoiceCaptureControlProps {
  disabled: boolean;
  /** Hook-owned activity; used only to mirror an external cancellation edge. */
  captureActive: boolean;
  capturePort: CapturePort;
  onStateChange?(state: VoiceCaptureState): void;
}

/**
 * Compatibility-only shape for the old direct visual-review/component caller.
 * ChatComposer never exposes this identified callback surface.
 */
interface LegacyVoiceCaptureControlProps {
  disabled: boolean;
  captureActive: boolean;
  onStart(mode: LegacyCaptureMode): Promise<string>;
  onCommit(captureId: string): Promise<void>;
  onCancel(captureId: string): Promise<void>;
  onStateChange?(state: VoiceCaptureState): void;
}

export type VoiceCaptureControlProps = InternalVoiceCaptureControlProps | LegacyVoiceCaptureControlProps;

type ReleaseOutcome = "auto" | "commit" | "cancel";

/** A quick activation latches Auto; longer holds default to Send. */
const QUICK_AUTO_THRESHOLD_MS = 220;
const QUICK_AUTO_DISTANCE_PX = 12;
const FAN_REVEAL_MS = 105;

function isInternalProps(props: VoiceCaptureControlProps): props is InternalVoiceCaptureControlProps {
  return "capturePort" in props;
}

function safelyVibrate(): void {
  try {
    if (window.matchMedia?.("(pointer: coarse)").matches) navigator.vibrate?.(8);
  } catch {
    // Labels and material changes are the primary feedback.
  }
}

function isPermissionDenial(error: unknown): boolean {
  return typeof DOMException !== "undefined"
    && error instanceof DOMException
    && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function ignoreFailure(operation: Promise<void>): void {
  void operation.catch(() => undefined);
}

async function discard(port: CapturePort, id: string): Promise<void> {
  try {
    await port.cancel(id);
  } catch {
    // A stale or teardown cancellation cannot be surfaced to the composer.
  }
}

/** @internal Rendered only by ChatComposer; direct export remains for the legacy QA specimen. */
export function VoiceCaptureControl(props: VoiceCaptureControlProps): JSX.Element {
  const internal = isInternalProps(props);
  const legacySourceRef = useRef<LegacyCaptureSource | null>(null);
  if (!internal) {
    legacySourceRef.current = {
      kind: "legacy",
      onStart: props.onStart,
      onCommit: props.onCommit,
      onCancel: props.onCancel,
    };
  }
  const legacyPortRef = useRef<CapturePort | null>(null);
  if (!internal && legacyPortRef.current === null) {
    legacyPortRef.current = createCapturePort(() => {
      if (legacySourceRef.current === null) throw new Error("Legacy capture source is unavailable.");
      return legacySourceRef.current;
    });
  }
  const capturePort: CapturePort = internal
    ? props.capturePort
    : legacyPortRef.current as CapturePort;

  const onStateChangeRef = useRef<((state: VoiceCaptureState) => void) | undefined>(undefined);
  onStateChangeRef.current = props.onStateChange;
  const [state, setState] = useState<VoiceCaptureState>(() => props.disabled ? "reconnect-disabled" : "idle");
  const [target, setTarget] = useState<VoiceCaptureTarget>("send");
  const [fanOpen, setFanOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const stateRef = useRef(state);
  const captureRef = useRef<string | null>(null);
  const pointerRef = useRef<{ id: number; at: number; x: number; y: number } | null>(null);
  const targetRef = useRef<VoiceCaptureTarget>("send");
  const fanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const operationPendingRef = useRef(false);
  const startPendingRef = useRef(false);
  const pendingReleaseRef = useRef<ReleaseOutcome | null>(null);
  const disabledRef = useRef(props.disabled);
  const previousCaptureActiveRef = useRef(props.captureActive);
  const mountedRef = useRef(true);
  const fanRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const autoChoiceRef = useRef<HTMLButtonElement>(null);
  const sendChoiceRef = useRef<HTMLButtonElement>(null);
  const keyboardHoldPendingRef = useRef(false);
  const cycleFromDefaultSendRef = useRef(false);
  // A pointer gesture is handled by pointer-up. Its follow-up click must not
  // also activate Auto; a real click on active Auto has no such marker.
  const suppressNextClickRef = useRef(false);

  disabledRef.current = props.disabled;

  function clearFanTimer(): void {
    if (fanTimerRef.current !== null) clearTimeout(fanTimerRef.current);
    fanTimerRef.current = null;
  }

  function updateState(next: VoiceCaptureState): void {
    stateRef.current = next;
    if (!mountedRef.current) return;
    setState(next);
    onStateChangeRef.current?.(next);
  }

  function announce(message: string): void {
    if (!mountedRef.current) return;
    setAnnouncement("");
    queueMicrotask(() => {
      if (mountedRef.current) setAnnouncement(message);
    });
  }

  function focusPrimary(): void {
    queueMicrotask(() => {
      const primary = primaryRef.current;
      if (mountedRef.current && primary && !primary.disabled) primary.focus({ preventScroll: true });
    });
  }

  async function start(mode: "hold" | "auto"): Promise<string | null> {
    if (disabledRef.current || captureRef.current !== null || operationPendingRef.current) return null;
    operationPendingRef.current = true;
    startPendingRef.current = true;
    const generation = ++generationRef.current;
    updateState("transitioning");
    try {
      const id = await capturePort.start(mode);
      if (!mountedRef.current || generation !== generationRef.current || disabledRef.current) {
        await discard(capturePort, id);
        return null;
      }
      captureRef.current = id;
      updateState(mode === "hold" ? "hold" : "auto");
      announce(mode === "hold" ? "Listening. Send selected." : "Auto listening on.");
      return id;
    } catch (error) {
      if (generation !== generationRef.current || !mountedRef.current) return null;
      updateState(isPermissionDenial(error) ? "permission-denied" : "start-failed");
      announce(isPermissionDenial(error)
        ? "Microphone permission denied. Text input is still available."
        : "Microphone could not start. Text input is still available.");
      return null;
    } finally {
      startPendingRef.current = false;
      operationPendingRef.current = false;
    }
  }

  function beginTerminal(id: string): number | null {
    if (captureRef.current !== id || operationPendingRef.current) return null;
    operationPendingRef.current = true;
    captureRef.current = null;
    keyboardHoldPendingRef.current = false;
    cycleFromDefaultSendRef.current = false;
    clearFanTimer();
    pointerRef.current = null;
    pendingReleaseRef.current = null;
    setFanOpen(false);
    const generation = ++generationRef.current;
    updateState("transitioning");
    focusPrimary();
    return generation;
  }

  async function terminal(
    kind: "commit" | "cancel",
    expectedId = captureRef.current,
    completionAnnouncement?: string,
  ): Promise<boolean> {
    if (expectedId === null || expectedId === undefined) return false;
    const generation = beginTerminal(expectedId);
    if (generation === null) return false;
    try {
      if (kind === "commit") await capturePort.commit(expectedId);
      else await capturePort.cancel(expectedId);
    } catch {
      if (generation !== generationRef.current || !mountedRef.current) {
        operationPendingRef.current = false;
        return true;
      }
      if (!disabledRef.current) updateState("start-failed");
      announce("Voice capture could not finish. Text input is still available.");
      operationPendingRef.current = false;
      return true;
    }
    if (generation !== generationRef.current || !mountedRef.current) {
      operationPendingRef.current = false;
      return true;
    }
    updateState(disabledRef.current ? "reconnect-disabled" : "idle");
    announce(completionAnnouncement ?? (kind === "commit" ? "Voice message sent." : "Voice message cancelled."));
    operationPendingRef.current = false;
    return true;
  }

  async function enterAutoFromHold(id: string): Promise<void> {
    const generation = beginTerminal(id);
    if (generation === null) return;
    try {
      const nextId = await capturePort.auto(id, () => mountedRef.current && generation === generationRef.current && !disabledRef.current);
      if (nextId === null) {
        if (mountedRef.current && generation === generationRef.current && !disabledRef.current) {
          updateState("idle");
          announce("Voice capture cancelled.");
        }
        operationPendingRef.current = false;
        return;
      }
      if (!mountedRef.current || generation !== generationRef.current || disabledRef.current) {
        await discard(capturePort, nextId);
        operationPendingRef.current = false;
        return;
      }
      captureRef.current = nextId;
      updateState("auto");
      announce("Auto listening on.");
      operationPendingRef.current = false;
    } catch {
      if (generation !== generationRef.current || !mountedRef.current) {
        operationPendingRef.current = false;
        return;
      }
      updateState("start-failed");
      announce("Microphone could not start. Text input is still available.");
      operationPendingRef.current = false;
    }
  }

  function selectTarget(next: VoiceCaptureTarget): void {
    if (targetRef.current === next) return;
    targetRef.current = next;
    setTarget(next);
    announce(`${targetLabel(next)} selected.`);
    safelyVibrate();
  }

  function targetAt(x: number, y: number): VoiceCaptureTarget {
    const fan = fanRef.current?.getBoundingClientRect();
    const pod = primaryRef.current?.getBoundingClientRect();
    if (!fan || !pod) return "send";

    const left = Math.min(fan.left, pod.left);
    const right = Math.max(fan.right, pod.right);
    const top = Math.min(fan.top, pod.top);
    const bottom = Math.max(fan.bottom, pod.bottom);
    if (right <= left || bottom <= top || x < left || x > right || y < top || y > bottom) return "send";

    const regionWidth = (right - left) / 3;
    const centers: readonly [VoiceCaptureTarget, number][] = [
      ["auto", left + regionWidth * 0.5],
      ["cancel", left + regionWidth * 1.5],
      ["send", left + regionWidth * 2.5],
    ];
    return centers.reduce((nearest, candidate) => (
      Math.abs(x - candidate[1]) < Math.abs(x - nearest[1]) ? candidate : nearest
    ))[0];
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button > 0 || disabledRef.current || stateRef.current !== "idle") return;
    event.preventDefault();
    suppressNextClickRef.current = true;
    const pointerId = event.pointerId;
    pointerRef.current = { id: pointerId, at: Date.now(), x: event.clientX, y: event.clientY };
    targetRef.current = "send";
    setTarget("send");
    pendingReleaseRef.current = null;
    primaryRef.current?.setPointerCapture?.(pointerId);
    void start("hold").then((id) => {
      if (id === null) return;
      const pending = pendingReleaseRef.current;
      pendingReleaseRef.current = null;
      if (pending === "auto") void enterAutoFromHold(id);
      else if (pending === "cancel") void terminal("cancel", id);
      else if (pending === "commit") void terminal("commit", id);
      else if (pointerRef.current?.id === pointerId) {
        fanTimerRef.current = setTimeout(() => {
          if (pointerRef.current?.id === pointerId && captureRef.current === id) setFanOpen(true);
        }, FAN_REVEAL_MS);
      }
    });
  }

  function handlePointerMove(event: PointerEvent): void {
    const pointer = pointerRef.current;
    if (pointer === null || pointer.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
    if (Date.now() - pointer.at >= 72 || distance >= 8) {
      setFanOpen(true);
      selectTarget(targetAt(event.clientX, event.clientY));
    }
  }

  function releasePointer(event: PointerEvent, cancelled: boolean): void {
    const pointer = pointerRef.current;
    if (pointer === null || pointer.id !== event.pointerId) return;
    pointerRef.current = null;
    clearFanTimer();
    try {
      primaryRef.current?.releasePointerCapture?.(event.pointerId);
    } catch {
      // The browser may have released the capture already.
    }
    const id = captureRef.current;
    const elapsed = Date.now() - pointer.at;
    const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
    const releaseTarget = targetAt(event.clientX, event.clientY);
    const outcome: ReleaseOutcome = cancelled
      ? "cancel"
      : (elapsed < QUICK_AUTO_THRESHOLD_MS && distance < QUICK_AUTO_DISTANCE_PX) || releaseTarget === "auto"
        ? "auto"
        : releaseTarget === "cancel" ? "cancel" : "commit";
    if (id === null) {
      pendingReleaseRef.current = outcome;
      return;
    }
    if (outcome === "auto") void enterAutoFromHold(id);
    else void terminal(outcome, id);
  }

  function activatePrimary(): void {
    if (disabledRef.current) return;
    if (stateRef.current === "auto") void terminal("cancel", captureRef.current, "Auto listening off.");
    else if (stateRef.current === "idle" || stateRef.current === "permission-denied" || stateRef.current === "start-failed") void start("auto");
  }

  // The runtime adapter terminalizes the capture. Mirror only its active→idle
  // edge so the UI does not emit a duplicate terminal intent.
  useEffect(() => {
    const wasActive = previousCaptureActiveRef.current;
    previousCaptureActiveRef.current = props.captureActive;
    if (!wasActive || props.captureActive) return;
    const id = captureRef.current;
    if (id === null && !startPendingRef.current) return;
    ++generationRef.current;
    captureRef.current = null;
    if (id !== null) capturePort.invalidate(id);
    keyboardHoldPendingRef.current = false;
    cycleFromDefaultSendRef.current = false;
    pointerRef.current = null;
    pendingReleaseRef.current = null;
    clearFanTimer();
    setFanOpen(false);
    updateState(disabledRef.current ? "reconnect-disabled" : "idle");
    announce("Voice capture cancelled by the system.");
    focusPrimary();
  }, [props.captureActive, capturePort]);

  // Disconnect and view disappearance discard, never commit, the identified
  // capture. Pending starts are fenced by the same generation.
  useEffect(() => {
    if (props.disabled) {
      const id = captureRef.current;
      ++generationRef.current;
      captureRef.current = null;
      keyboardHoldPendingRef.current = false;
      cycleFromDefaultSendRef.current = false;
      pointerRef.current = null;
      pendingReleaseRef.current = null;
      clearFanTimer();
      setFanOpen(false);
      if (id !== null) ignoreFailure(capturePort.cancel(id));
      updateState("reconnect-disabled");
    } else if (stateRef.current === "reconnect-disabled") {
      updateState("idle");
    }
  }, [props.disabled, capturePort]);

  // Keyboard Hold opens on the safe Send default. Its first forward Tab wraps
  // to the visual start, after which native DOM order is Auto → Cancel → Send.
  useEffect(() => {
    if (!keyboardHoldPendingRef.current || state !== "hold" || !fanOpen) return;
    keyboardHoldPendingRef.current = false;
    cycleFromDefaultSendRef.current = true;
    sendChoiceRef.current?.focus({ preventScroll: true });
  }, [state, fanOpen]);

  useEffect(() => () => {
    mountedRef.current = false;
    ++generationRef.current;
    keyboardHoldPendingRef.current = false;
    cycleFromDefaultSendRef.current = false;
    clearFanTimer();
    const id = captureRef.current;
    captureRef.current = null;
    pointerRef.current = null;
    if (id !== null) ignoreFailure(capturePort.cancel(id));
  }, [capturePort]);

  const presentation = mapVoiceCapturePresentation(state, props.disabled, fanOpen);

  return (
    <>
      <div class={`dock-voice-capture dock-voice-capture--${presentation.state}`} data-state={presentation.state} data-tone={presentation.tone} data-target={target}>
        <div
          ref={fanRef}
          class={`dock-voice-capture__fan${presentation.fanOpen ? " dock-voice-capture__fan--open" : ""}`}
          data-target={target}
          role="group"
          aria-label="Hold voice capture actions"
          aria-hidden={!presentation.fanOpen}
        >
          {(["auto", "cancel", "send"] as const).map((choice) => (
            <button
              key={choice}
              ref={choice === "auto" ? autoChoiceRef : choice === "send" ? sendChoiceRef : null}
              type="button"
              class={`dock-voice-capture__choice dock-voice-capture__choice--${choice}${target === choice ? " is-selected" : ""}`}
              data-voice-target={choice}
              tabIndex={presentation.fanOpen ? 0 : -1}
              aria-label={choice === "auto" ? "Switch to Auto listening" : choice === "cancel" ? "Cancel voice message" : "Send voice message"}
              onFocus={() => {
                if (choice !== "send") cycleFromDefaultSendRef.current = false;
              }}
              onKeyDown={(event) => {
                if (choice !== "send" || event.key !== "Tab" || event.shiftKey || !cycleFromDefaultSendRef.current) return;
                event.preventDefault();
                cycleFromDefaultSendRef.current = false;
                autoChoiceRef.current?.focus({ preventScroll: true });
              }}
              onPointerEnter={() => selectTarget(choice)}
              onClick={() => {
                const id = captureRef.current;
                if (id === null) return;
                if (choice === "auto") void enterAutoFromHold(id);
                else void terminal(choice === "cancel" ? "cancel" : "commit", id);
              }}
            >
              <ComposerGlyph name={choice} size={18} />
              <span>{choice === "auto" ? "Auto" : choice === "cancel" ? "Cancel" : "Send"}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          class="dock-voice-capture__hold-access sr-only"
          disabled={presentation.disabled || state !== "idle"}
          onClick={() => {
            keyboardHoldPendingRef.current = true;
            const pendingStart = start("hold");
            focusPrimary();
            void pendingStart.then((id) => {
              if (id === null) {
                keyboardHoldPendingRef.current = false;
                focusPrimary();
                return;
              }
              setFanOpen(true);
              announce("Hold listening. Send selected. Choose Auto, Cancel, or Send.");
            });
          }}
        >Start Hold voice capture</button>
        <button
          ref={primaryRef}
          type="button"
          class="dock-voice-capture__primary"
          disabled={presentation.disabled}
          aria-label={presentation.primaryLabel}
          aria-pressed={presentation.primaryPressed}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => releasePointer(event, false)}
          onPointerCancel={(event) => releasePointer(event, true)}
          onClick={(event) => {
            if (event.detail > 0 && suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              return;
            }
            suppressNextClickRef.current = false;
            if (event.detail === 0 || stateRef.current === "auto") activatePrimary();
          }}
        >
          {presentation.live && <span class="dock-voice-capture__wave" aria-hidden="true">{Array.from({ length: 11 }, (_, index) => <i key={index} />)}</span>}
          <span class="dock-voice-capture__glyph" aria-hidden="true">
            <ComposerGlyph name={presentation.primaryPressed ? "auto" : "mic"} size={presentation.primaryPressed ? 18 : 20} />
          </span>
        </button>
        <span class="sr-only" aria-live="polite">{announcement}</span>
      </div>
    </>
  );
}
