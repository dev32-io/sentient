import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { CycleStatus } from "../../hooks/cycle-helpers.ts";
import { InterruptButton } from "./interrupt-button.tsx";
import { MicButton } from "./mic-button.tsx";
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
  onMicToggle(): void;
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
  const { onSendText, onMicToggle, onTtsToggle, onInterrupt, onSuggestionClick } = props;

  const [text, setText] = useState("");
  const [submitBlockedFlash, setSubmitBlockedFlash] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Touch devices: blur after send to dismiss the on-screen keyboard so the
  // freshly streaming reply isn't hidden behind it. Desktop keeps focus.
  const blurAfterSend = useRef(isTouchDevice());
  const shortPlaceholder = useRef(isNarrowViewport());

  const voiceActive = voiceMode === "active";
  const isStreaming = cycleStatus !== "idle";

  const composerClasses = [
    "composer",
    voiceActive ? "composer--listening" : "",
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
        <div class={composerClasses}>
          {!connectionReady && (
            <div class={`composer__connection-pill${submitBlockedFlash ? " composer__connection-pill--flash" : ""}`}>
              Reconnecting…
            </div>
          )}
          <textarea
            ref={areaRef}
            class="composer__textarea"
            placeholder={placeholderFor(voiceMode, shortPlaceholder.current)}
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={handleKeyDown}
          />
          <div class="composer__bottom-row">
            <MicButton active={voiceActive} onToggle={onMicToggle} />
            <TtsButton enabled={ttsEnabled} onToggle={onTtsToggle} />
            <span class="composer__spacer" />
            <SendButton disabled={sendDisabled} onSend={submit} />
            {canInterrupt && <InterruptButton onInterrupt={onInterrupt} />}
          </div>
        </div>
        <SuggestionChips suggestions={suggestions} onClick={onSuggestionClick} />
      </div>
    </div>
  );
}
