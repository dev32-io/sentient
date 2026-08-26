import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../common/icon.tsx";

export type VoiceCaptureMode = "manual" | "semantic";
export type VoiceCaptureState =
  | "idle"
  | "hold"
  | "auto"
  | "transitioning"
  | "permission-denied"
  | "start-failed"
  | "reconnect-disabled";

export interface VoiceCaptureControlProps {
  disabled: boolean;
  /** Hook-owned hardware/connector activity; used only for external cancellation edges. */
  captureActive: boolean;
  onStart(mode: VoiceCaptureMode): Promise<string>;
  onCommit(captureId: string): Promise<void>;
  onCancel(captureId: string): Promise<void>;
  onStateChange?(state: VoiceCaptureState): void;
}

type Target = "auto" | "cancel" | "send";

/** A quick activation latches Auto; longer holds default to Send. */
export const QUICK_AUTO_THRESHOLD_MS = 220;
const QUICK_AUTO_DISTANCE_PX = 12;
const FAN_REVEAL_MS = 105;

function safelyVibrate(): void {
  try {
    if (matchMedia("(pointer: coarse)").matches) navigator.vibrate?.(8);
  } catch {
    // Labels and material changes are the primary feedback.
  }
}

function isPermissionDenial(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

export function VoiceCaptureControl(props: VoiceCaptureControlProps): JSX.Element {
  const { disabled, captureActive, onStart, onCommit, onCancel, onStateChange } = props;
  const [state, setState] = useState<VoiceCaptureState>(disabled ? "reconnect-disabled" : "idle");
  const [target, setTarget] = useState<Target>("send");
  const [fanOpen, setFanOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const stateRef = useRef(state);
  const captureRef = useRef<string | null>(null);
  const pointerRef = useRef<{ id: number; at: number; x: number; y: number } | null>(null);
  const fanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const pendingReleaseRef = useRef<"auto" | "commit" | "cancel" | null>(null);
  const onCancelRef = useRef(onCancel);
  const disabledRef = useRef(disabled);
  const previousCaptureActiveRef = useRef(captureActive);
  onCancelRef.current = onCancel;
  disabledRef.current = disabled;
  const buttonRef = useRef<HTMLButtonElement>(null);

  function clearFanTimer(): void {
    if (fanTimerRef.current !== null) clearTimeout(fanTimerRef.current);
    fanTimerRef.current = null;
  }

  function updateState(next: VoiceCaptureState): void {
    stateRef.current = next;
    setState(next);
    onStateChange?.(next);
  }

  function announce(message: string): void {
    setAnnouncement("");
    queueMicrotask(() => setAnnouncement(message));
  }

  async function start(mode: VoiceCaptureMode): Promise<string | null> {
    if (disabled || captureRef.current !== null) return null;
    const generation = ++generationRef.current;
    updateState("transitioning");
    try {
      const id = await onStart(mode);
      if (generation !== generationRef.current) {
        await onCancel(id);
        return null;
      }
      captureRef.current = id;
      updateState(mode === "manual" ? "hold" : "auto");
      announce(mode === "manual" ? "Listening. Send selected." : "Auto listening on.");
      return id;
    } catch (error) {
      if (generation !== generationRef.current) return null;
      updateState(isPermissionDenial(error) ? "permission-denied" : "start-failed");
      announce(isPermissionDenial(error) ? "Microphone permission denied. Text input is still available." : "Microphone could not start. Text input is still available.");
      return null;
    }
  }

  async function terminal(kind: "commit" | "cancel", expectedId = captureRef.current): Promise<boolean> {
    if (expectedId === null || captureRef.current !== expectedId) return false;
    captureRef.current = null;
    clearFanTimer();
    setFanOpen(false);
    updateState("transitioning");
    if (kind === "commit") await onCommit(expectedId);
    else await onCancel(expectedId);
    if (!disabledRef.current) updateState("idle");
    announce(kind === "commit" ? "Voice message sent." : "Voice message cancelled.");
    return true;
  }

  async function enterAutoFromHold(id: string): Promise<void> {
    if (!(await terminal("commit", id)) || disabledRef.current) return;
    await start("semantic");
  }

  function selectTarget(next: Target): void {
    if (target === next) return;
    setTarget(next);
    announce(`${next === "auto" ? "Auto" : next === "cancel" ? "Cancel" : "Send"} selected.`);
    safelyVibrate();
  }

  function targetAt(x: number, y: number): Target {
    const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-voice-target]");
    const value = element?.dataset.voiceTarget;
    return value === "auto" || value === "cancel" ? value : "send";
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button > 0 || disabled || stateRef.current !== "idle") return;
    event.preventDefault();
    pointerRef.current = { id: event.pointerId, at: Date.now(), x: event.clientX, y: event.clientY };
    setTarget("send");
    pendingReleaseRef.current = null;
    buttonRef.current?.setPointerCapture?.(event.pointerId);
    void start("manual").then((id) => {
      if (id === null) return;
      const pending = pendingReleaseRef.current;
      pendingReleaseRef.current = null;
      if (pending === "auto") void enterAutoFromHold(id);
      else if (pending === "cancel") void terminal("cancel", id);
      else if (pending === "commit") void terminal("commit", id);
      else if (pointerRef.current?.id === event.pointerId) fanTimerRef.current = setTimeout(() => setFanOpen(true), FAN_REVEAL_MS);
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
    try { buttonRef.current?.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    const id = captureRef.current;
    const elapsed = Date.now() - pointer.at;
    const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
    const outcome = cancelled
      ? "cancel"
      : (elapsed < QUICK_AUTO_THRESHOLD_MS && distance < QUICK_AUTO_DISTANCE_PX) || target === "auto"
        ? "auto"
        : target === "cancel" ? "cancel" : "commit";
    if (id === null) {
      pendingReleaseRef.current = outcome;
      return;
    }
    if (outcome === "auto") void enterAutoFromHold(id);
    else void terminal(outcome, id);
  }

  function activatePrimary(): void {
    if (disabled) return;
    if (stateRef.current === "auto") void terminal("commit");
    else if (stateRef.current === "idle" || stateRef.current === "permission-denied" || stateRef.current === "start-failed") void start("semantic");
  }

  // Runtime adapter/system cancellation is terminalized by the hook. Mirror
  // its active→inactive edge without emitting a duplicate terminal.
  useEffect(() => {
    const wasActive = previousCaptureActiveRef.current;
    previousCaptureActiveRef.current = captureActive;
    if (!wasActive || captureActive || captureRef.current === null) return;
    ++generationRef.current;
    captureRef.current = null;
    pointerRef.current = null;
    clearFanTimer();
    setFanOpen(false);
    updateState(disabledRef.current ? "reconnect-disabled" : "idle");
    announce("Voice capture cancelled by the system.");
  }, [captureActive]);

  // Disconnect and view disappearance discard, never commit, the identified capture.
  useEffect(() => {
    if (disabled) {
      const id = captureRef.current;
      ++generationRef.current;
      pointerRef.current = null;
      if (id !== null) void terminal("cancel", id);
      updateState("reconnect-disabled");
    } else if (stateRef.current === "reconnect-disabled") {
      updateState("idle");
    }
  }, [disabled]);

  useEffect(() => () => {
    clearFanTimer();
    ++generationRef.current;
    const id = captureRef.current;
    captureRef.current = null;
    if (id !== null) void onCancelRef.current(id);
  }, []);

  const live = state === "hold" || state === "auto" || state === "transitioning";
  const primaryLabel = disabled
    ? "Voice unavailable while reconnecting"
    : state === "auto"
      ? "Auto listening is on; activate to send and turn it off"
      : "Tap for Auto listening or hold to talk";

  return (
    <div class={`voice-capture voice-capture--${state}`} data-state={state}>
      <div class={`voice-capture__fan${fanOpen ? " voice-capture__fan--open" : ""}`} aria-hidden={!fanOpen}>
        {(["auto", "cancel", "send"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            class={`voice-capture__choice voice-capture__choice--${choice}${target === choice ? " is-selected" : ""}`}
            data-voice-target={choice}
            tabIndex={fanOpen ? 0 : -1}
            aria-label={choice === "auto" ? "Switch to Auto listening" : choice === "cancel" ? "Cancel voice message" : "Send voice message"}
            onPointerEnter={() => selectTarget(choice)}
            onClick={() => {
              const id = captureRef.current;
              if (id === null) return;
              if (choice === "auto") void enterAutoFromHold(id);
              else void terminal(choice === "cancel" ? "cancel" : "commit", id);
            }}
          >
            {choice === "auto" ? <Icon name="waveform" size={15} /> : <Icon name={choice === "cancel" ? "x" : "send"} size={15} />}
            <span>{choice === "auto" ? "Auto" : choice === "cancel" ? "Cancel" : "Send"}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        class="voice-capture__hold-access sr-only"
        disabled={disabled || state !== "idle"}
        onClick={() => {
          void start("manual").then((id) => {
            if (id !== null) {
              setFanOpen(true);
              announce("Hold listening. Choose Send, Cancel, or Auto.");
            }
          });
        }}
      >Start Hold voice capture</button>
      <button
        ref={buttonRef}
        type="button"
        class="voice-capture__primary"
        disabled={disabled}
        aria-label={primaryLabel}
        aria-pressed={state === "auto"}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => releasePointer(event, false)}
        onPointerCancel={(event) => releasePointer(event, true)}
        onClick={(event) => { if (event.detail === 0) activatePrimary(); }}
      >
        {live && <span class="voice-capture__wave" aria-hidden="true">{Array.from({ length: 13 }, (_, index) => <i key={index} />)}</span>}
        <span class="voice-capture__glyph" aria-hidden="true">
          <Icon name={state === "auto" ? "waveform" : "mic"} size={19} />
        </span>
      </button>
      <span class="sr-only" aria-live="polite">{announcement}</span>
    </div>
  );
}
