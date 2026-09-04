import type { TaskListItem } from "@sentient/protocol";
import type { JSX, RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import type { CycleStatus } from "../../hooks/cycle-helpers.ts";
import { Surface } from "../common/foundation.tsx";
import { Icon } from "../common/icon.tsx";
import { type CapturePort, createCapturePort, legacySource, semanticSource, type LegacyCaptureMode, type CaptureSource } from "./capture-adapter.ts";
import type { ChatComposerProps as SemanticChatComposerProps } from "./composer-api.ts";
import { DockStyleSheet } from "./dock-styles.tsx";
import { ComposerTaskShelf } from "./composer-task-strip.tsx";
import { InterruptButton } from "./interrupt-button.tsx";
import { SuggestionChips } from "./suggestion-chips.tsx";
import { TtsButton } from "./tts-button.tsx";
import { VoiceCaptureControl, type VoiceCaptureState } from "./voice-capture-control.tsx";

export type { CaptureIntent, ChatComposerProps } from "./composer-api.ts";

// The public product boundary below composes the private DraftEditor and
// ComposerActions layers. TaskShelf and VoiceCaptureControl own their own
// state; screens only provide value, server state, and semantic callbacks.

/** Compatibility adapter for the current screen until it adopts intents. */
interface LegacyChatComposerProps {
  cycleStatus: CycleStatus;
  connectionReady: boolean;
  captureActive: boolean;
  ttsEnabled: boolean;
  suggestions: readonly string[];
  tasks: readonly TaskListItem[];
  onSendText(text: string): void;
  onCaptureStart(mode: LegacyCaptureMode): Promise<string>;
  onCaptureCommit(captureId: string): Promise<void>;
  onCaptureCancel(captureId: string): Promise<void>;
  onTtsToggle(): void;
  onInterrupt(): void;
  onSuggestionClick(text: string): void;
}

type ChatComposerInputProps = SemanticChatComposerProps | LegacyChatComposerProps;

function isSemanticProps(props: ChatComposerInputProps): props is SemanticChatComposerProps {
  return "onCaptureIntent" in props;
}

function isTouchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
}

interface DraftEditorProps {
  value: string;
  receded: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  onValueChange(value: string): void;
  onSubmit(): void;
}

function DraftEditor({ value, receded, inputRef, onValueChange, onSubmit }: DraftEditorProps): JSX.Element {
  return (
    <textarea
      ref={inputRef}
      class={`dock-composer__draft${receded ? " dock-composer__draft--receded" : ""}`}
      aria-label="Message Sentient"
      placeholder="Message or speak to Sentient"
      rows={1}
      value={value}
      onInput={(event) => onValueChange(event.currentTarget.value)}
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
  capturePort: CapturePort;
  onSend(): void;
  onTtsToggle(): void;
  onInterrupt(): void;
  onVoiceState(state: VoiceCaptureState): void;
}

function ComposerActions(props: ComposerActionsProps): JSX.Element {
  return (
    <div class="dock-composer__actions">
      <button
        type="button"
        class="dock-composer-control dock-composer__attachment"
        disabled
        aria-label="Attachments are not available"
        title="Attachments are not available"
      >
        <Icon name="paperclip" size={19} />
      </button>
      <TtsButton enabled={props.ttsEnabled} onToggle={props.onTtsToggle} />
      <span class="dock-composer__grow" />
      <div class={`dock-composer__end-actions${props.held ? " dock-composer__end-actions--held" : ""}`}>
        {props.canInterrupt && (
          <span class={`dock-composer__interrupt${props.held ? " dock-composer__interrupt--receded" : ""}`}>
            <InterruptButton onInterrupt={props.onInterrupt} />
          </span>
        )}
        {props.draftPresent ? (
          <button
            type="button"
            class="dock-composer-control dock-composer-control--primary dock-composer__send"
            disabled={!props.connectionReady}
            aria-label="Send message"
            title="Send message"
            onClick={props.onSend}
          >
            <Icon name="send" size={19} />
          </button>
        ) : (
          <VoiceCaptureControl
            disabled={!props.connectionReady}
            captureActive={props.captureActive}
            capturePort={props.capturePort}
            onStateChange={props.onVoiceState}
          />
        )}
      </div>
    </div>
  );
}

export function ChatComposer(props: SemanticChatComposerProps): JSX.Element;
export function ChatComposer(props: LegacyChatComposerProps): JSX.Element;
export function ChatComposer(props: ChatComposerInputProps): JSX.Element {
  const semantic = isSemanticProps(props);
  const [legacyDraft, setLegacyDraft] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceCaptureState>(() => props.connectionReady ? "idle" : "reconnect-disabled");
  const [blockedFlash, setBlockedFlash] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const blurAfterSend = useRef(isTouchDevice());
  const sourceRef = useRef<CaptureSource | null>(null);
  sourceRef.current = semantic
    ? semanticSource(props.onCaptureIntent)
    : legacySource({
      onStart: props.onCaptureStart,
      onCommit: props.onCaptureCommit,
      onCancel: props.onCaptureCancel,
    });
  const capturePortRef = useRef<CapturePort | null>(null);
  if (capturePortRef.current === null) {
    capturePortRef.current = createCapturePort(() => {
      if (sourceRef.current === null) throw new Error("Composer capture source is unavailable.");
      return sourceRef.current;
    });
  }
  const capturePort: CapturePort = capturePortRef.current;

  const draft = semantic ? props.value : legacyDraft;
  const onValueChange = semantic ? props.onValueChange : setLegacyDraft;
  const submitText = semantic ? props.onTextSubmit : props.onSendText;
  const onTtsToggle = props.onTtsToggle;
  const onInterrupt = props.onInterrupt;
  const onSuggestionClick = props.onSuggestionClick;
  const held = voiceState === "hold";
  const captureLive = voiceState === "hold" || voiceState === "auto" || voiceState === "transitioning";
  // `awaiting-tasks` may contain only background work. Do not present a
  // foreground Interrupt for that state; a foreground row remains explicit.
  const canInterrupt = props.cycleStatus === "streaming"
    || props.cycleStatus === "speaking"
    || props.tasks.some((task) => task.kind === "foreground" && task.status === "running");

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
    submitText(text);
    onValueChange("");
    if (blurAfterSend.current) editorRef.current?.blur();
    else focusEditor();
  }

  return (
    <>
      <DockStyleSheet />
      <Surface className="dock-composer">
        <div class="dock-composer__inner">
          <div class="dock-composer__frame">
            <ComposerTaskShelf items={props.tasks} />
            <div
              class={`dock-composer__surface dock-composer__surface--${voiceState}`}
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
                <div class={`dock-composer__connection${blockedFlash ? " dock-composer__connection--flash" : ""}`} role="status">Reconnecting…</div>
              )}
              <DraftEditor value={draft} receded={held} inputRef={editorRef} onValueChange={onValueChange} onSubmit={submit} />
              <ComposerActions
                draftPresent={!captureLive && draft.trim().length > 0}
                held={held}
                canInterrupt={canInterrupt}
                connectionReady={props.connectionReady}
                captureActive={props.captureActive}
                ttsEnabled={props.ttsEnabled}
                capturePort={capturePort}
                onSend={submit}
                onTtsToggle={() => { onTtsToggle(); focusEditor(); }}
                onInterrupt={() => { onInterrupt(); focusEditor(); }}
                onVoiceState={setVoiceState}
              />
            </div>
          </div>
          <SuggestionChips suggestions={props.suggestions} onClick={(text) => { onSuggestionClick(text); focusEditor(); }} />
        </div>
      </Surface>
    </>
  );
}
