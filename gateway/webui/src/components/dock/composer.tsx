import type { TaskListItem } from "@sentient/protocol";
import type { JSX, RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import type { CycleStatus } from "../../hooks/cycle-helpers.ts";
import { Icon } from "../common/icon.tsx";
import { ComposerTaskStrip } from "./composer-task-strip.tsx";
import { InterruptButton } from "./interrupt-button.tsx";
import { SuggestionChips } from "./suggestion-chips.tsx";
import { TtsButton } from "./tts-button.tsx";
import { type VoiceCaptureMode, type VoiceCaptureState, VoiceCaptureControl } from "./voice-capture-control.tsx";

export interface ChatComposerProps {
  cycleStatus: CycleStatus;
  connectionReady: boolean;
  captureActive: boolean;
  ttsEnabled: boolean;
  suggestions: readonly string[];
  /** Full-state `tasklist.state`; the composer never infers row lifetime. */
  tasks: readonly TaskListItem[];
  onSendText(text: string): void;
  onCaptureStart(mode: VoiceCaptureMode): Promise<string>;
  onCaptureCommit(captureId: string): Promise<void>;
  onCaptureCancel(captureId: string): Promise<void>;
  onTtsToggle(): void;
  onInterrupt(): void;
  onSuggestionClick(text: string): void;
}

function isTouchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
}

interface DraftEditorProps {
  value: string;
  hidden: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  onInput(value: string): void;
  onSubmit(): void;
}

function DraftEditor({ value, hidden, inputRef, onInput, onSubmit }: DraftEditorProps): JSX.Element {
  function resize(element: HTMLTextAreaElement): void {
    element.style.height = "auto";
    element.style.height = `${Math.min(132, Math.max(42, element.scrollHeight))}px`;
  }

  return (
    <textarea
      ref={inputRef}
      class={`chat-composer__draft${hidden ? " chat-composer__draft--receded" : ""}`}
      aria-label="Message Sentient"
      placeholder="Message Sentient"
      value={value}
      onInput={(event) => {
        const element = event.currentTarget;
        onInput(element.value);
        resize(element);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

interface ComposerActionsProps {
  draftPresent: boolean;
  held: boolean;
  canInterrupt: boolean;
  connectionReady: boolean;
  captureActive: boolean;
  ttsEnabled: boolean;
  onSend(): void;
  onTtsToggle(): void;
  onInterrupt(): void;
  onCaptureStart(mode: VoiceCaptureMode): Promise<string>;
  onCaptureCommit(captureId: string): Promise<void>;
  onCaptureCancel(captureId: string): Promise<void>;
  onVoiceState(state: VoiceCaptureState): void;
}

function ComposerActions(props: ComposerActionsProps): JSX.Element {
  return (
    <div class="chat-composer__actions">
      <button class="chat-composer__attach" type="button" disabled aria-label="Attachments are not available" title="Attachments are not available">
        <Icon name="plus" size={18} />
      </button>
      <TtsButton enabled={props.ttsEnabled} onToggle={props.onTtsToggle} />
      <span class="chat-composer__grow" />
      <span class={`chat-composer__interrupt${props.held ? " chat-composer__interrupt--receded" : ""}`}>
        {props.canInterrupt && <InterruptButton onInterrupt={props.onInterrupt} />}
      </span>
      {props.draftPresent ? (
        <button class="chat-composer__send" type="button" disabled={!props.connectionReady} aria-label="Send message" onClick={props.onSend}>
          <Icon name="send" size={17} />
        </button>
      ) : (
        <VoiceCaptureControl
          disabled={!props.connectionReady}
          captureActive={props.captureActive}
          onStart={props.onCaptureStart}
          onCommit={props.onCaptureCommit}
          onCancel={props.onCaptureCancel}
          onStateChange={props.onVoiceState}
        />
      )}
    </div>
  );
}

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceCaptureState>(props.connectionReady ? "idle" : "reconnect-disabled");
  const [blockedFlash, setBlockedFlash] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const blurAfterSend = useRef(isTouchDevice());
  const held = voiceState === "hold";
  const captureLive = voiceState === "hold" || voiceState === "auto" || voiceState === "transitioning";
  const canInterrupt = props.cycleStatus !== "idle";

  function focusEditor(): void {
    editorRef.current?.focus();
  }

  function submit(): void {
    const text = draft.trim();
    if (!text) return;
    if (!props.connectionReady) {
      setBlockedFlash(true);
      setTimeout(() => setBlockedFlash(false), 1500);
      return;
    }
    props.onSendText(text);
    setDraft("");
    if (blurAfterSend.current) editorRef.current?.blur();
    else focusEditor();
  }

  return (
    <div class="dock">
      <div class="dock-inner">
        <div class="chat-composer-frame">
          <ComposerTaskStrip items={props.tasks} />
          <div
            class={`chat-composer chat-composer--${voiceState}${!props.connectionReady ? " chat-composer--reconnecting" : ""}`}
            data-voice-state={voiceState}
            onPointerDown={(event) => {
              if ((event.target as Element).closest("textarea,button,input,a,[role='button']")) return;
              event.preventDefault();
              focusEditor();
              const length = editorRef.current?.value.length ?? 0;
              editorRef.current?.setSelectionRange(length, length);
            }}
          >
            {!props.connectionReady && (
              <div class={`chat-composer__connection${blockedFlash ? " chat-composer__connection--flash" : ""}`} role="status">Reconnecting…</div>
            )}
            <DraftEditor value={draft} hidden={held} inputRef={editorRef} onInput={setDraft} onSubmit={submit} />
            <ComposerActions
              draftPresent={!captureLive && draft.trim().length > 0}
              held={held}
              canInterrupt={canInterrupt}
              connectionReady={props.connectionReady}
              captureActive={props.captureActive}
              ttsEnabled={props.ttsEnabled}
              onSend={submit}
              onTtsToggle={() => { props.onTtsToggle(); focusEditor(); }}
              onInterrupt={() => { props.onInterrupt(); focusEditor(); }}
              onCaptureStart={props.onCaptureStart}
              onCaptureCommit={props.onCaptureCommit}
              onCaptureCancel={props.onCaptureCancel}
              onVoiceState={setVoiceState}
            />
          </div>
        </div>
        <SuggestionChips suggestions={props.suggestions} onClick={(text) => { props.onSuggestionClick(text); focusEditor(); }} />
      </div>
    </div>
  );
}
