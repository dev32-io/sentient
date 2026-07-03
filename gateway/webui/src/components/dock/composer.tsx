import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { CycleStatus } from "../../hooks/cycle-helpers.ts";
import { InterruptButton } from "./interrupt-button.tsx";
import { MicCorner } from "./mic-corner.tsx";
import type { MicCornerMode } from "./mic-corner-gesture.ts";
import { PttWave } from "./ptt-wave.tsx";
import { SendButton } from "./send-button.tsx";
import { SuggestionChips } from "./suggestion-chips.tsx";
import { TtsButton } from "./tts-button.tsx";

export interface ComposerProps {
  cycleStatus: CycleStatus;
  voiceMode: "off" | "active";
  canInterrupt: boolean;
  /**
   * True when the SDK is in `ready` state — text submission flows. False
   * during connect/auth/reconnect: Send button disables, submitting shows
   * an inline pill instead of clearing the textarea.
   */
  connectionReady: boolean;
  /** Reflects `useVoiceClient().prefs.value.ttsEnabled` — server-of-record. */
  ttsEnabled: boolean;
  suggestions: readonly string[];
  onSendText(text: string): void;
  /** Corner mic pressed/locked — start voice mode. Rejection resets the control. */
  onMicStart(): Promise<void>;
  /** Corner mic released/unlocked — stop voice mode. */
  onMicStop(): void;
  /** Optimistic flip + persist via profile PUT + WS preference patch. */
  onTtsToggle(): void;
  onInterrupt(): void;
  onSuggestionClick(text: string): void;
}

const VOICE_PLACEHOLDER = "Listening — just speak, or type here";
const IDLE_PLACEHOLDER = "Type or speak — Sentient will listen";
const VOICE_PLACEHOLDER_SHORT = "Listening — speak or type";
const IDLE_PLACEHOLDER_SHORT = "Message Sentient";

function placeholderFor(voiceMode: "off" | "active", short: boolean): string {
  if (voiceMode === "active") return short ? VOICE_PLACEHOLDER_SHORT : VOICE_PLACEHOLDER;
  return short ? IDLE_PLACEHOLDER_SHORT : IDLE_PLACEHOLDER;
}

// Stable per-mount: matched once. Two separate concerns:
//  - touch device → blur after send (dismiss the on-screen keyboard like
//    ChatGPT/Claude do; narrow desktop has no keyboard to dismiss)
//  - narrow viewport → use the short placeholder copy (also catches narrow
//    desktop windows, where the long copy wraps awkwardly)
function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches
  );
}

function isNarrowViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 620px)").matches
  );
}

export function Composer(props: ComposerProps): JSX.Element {
  const { cycleStatus, voiceMode, canInterrupt, connectionReady, ttsEnabled, suggestions } = props;
  const { onSendText, onMicStart, onMicStop, onTtsToggle, onInterrupt, onSuggestionClick } = props;

  const [text, setText] = useState("");
  const [submitBlockedFlash, setSubmitBlockedFlash] = useState(false);
  // Corner-mic mode drives the recording takeover: waveform overlays the
  // (hidden, draft-preserving) textarea and the row keeps only Interrupt.
  const [micMode, setMicMode] = useState<MicCornerMode>("idle");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Touch devices: blur after send to dismiss the on-screen keyboard so the
  // freshly streaming reply isn't hidden behind it. Desktop keeps focus.
  const blurAfterSend = useRef(isTouchDevice());
  const shortPlaceholder = useRef(isNarrowViewport());

  const voiceActive = voiceMode === "active";
  const isStreaming = cycleStatus !== "idle";
  const isLive = micMode !== "idle";

  const composerClasses = [
    "composer",
    voiceActive ? "composer--listening" : "",
    isLive ? "composer--live" : "",
    isStreaming ? "composer--streaming" : "",
    !connectionReady ? "composer--reconnecting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function submit(): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!connectionReady) {
      // Don't clear the input — surfacing the pill flash tells the user
      // the message wasn't sent and lets them try again on reconnect.
      setSubmitBlockedFlash(true);
      setTimeout(() => setSubmitBlockedFlash(false), 1500);
      return;
    }
    onSendText(trimmed);
    setText("");
    if (blurAfterSend.current) areaRef.current?.blur();
    else areaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const sendDisabled = text.trim().length === 0 || !connectionReady;

  return (
    <div class="dock">
      <div class="dock-inner">
        <div class="composer-shell">
          <MicCorner active={voiceActive} onModeChange={setMicMode} onStart={onMicStart} onStop={onMicStop} />
          <div class={composerClasses}>
            {!connectionReady && (
              <div class={`composer__connection-pill${submitBlockedFlash ? " composer__connection-pill--flash" : ""}`}>
                Reconnecting…
              </div>
            )}
            <textarea
              ref={areaRef}
              class={`composer__textarea${isLive ? " composer__textarea--hidden" : ""}`}
              placeholder={placeholderFor(voiceMode, shortPlaceholder.current)}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={handleKeyDown}
            />
            {isLive && (
              <div class="composer__wave-field">
                <PttWave />
              </div>
            )}
            <div class="composer__bottom-row">
              {!isLive && <TtsButton enabled={ttsEnabled} onToggle={onTtsToggle} />}
              <span class="composer__spacer" />
              {!isLive && <SendButton disabled={sendDisabled} onSend={submit} />}
              {canInterrupt && <InterruptButton onInterrupt={onInterrupt} />}
            </div>
          </div>
        </div>
        <SuggestionChips suggestions={suggestions} onClick={onSuggestionClick} />
      </div>
    </div>
  );
}
