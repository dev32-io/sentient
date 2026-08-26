import type { TaskListItem } from "@sentient/protocol";
import type { CycleStatus } from "../../hooks/cycle-helpers.ts";

/** The two user-visible ways a new capture can begin. */
export type CaptureStartMode = "hold" | "auto";

/**
 * Semantic capture commands understood by ChatComposer.
 *
 * Capture identity, generation fencing, and pointer details deliberately do
 * not cross this boundary. The host only receives product intents.
 */
export type CaptureIntent =
  | { readonly type: "start"; readonly mode: CaptureStartMode }
  | { readonly type: "commit" }
  | { readonly type: "cancel" }
  | { readonly type: "auto" };

export type CaptureIntentHandler = (intent: CaptureIntent) => void | Promise<void>;

/**
 * The only product-facing composer contract. Draft ownership is explicit so a
 * screen can persist or restore it without knowing anything about capture.
 */
export interface ChatComposerProps {
  cycleStatus: CycleStatus;
  connectionReady: boolean;
  /** Hook-owned activity edge used to mirror a system cancellation. */
  captureActive: boolean;
  ttsEnabled: boolean;
  suggestions: readonly string[];
  /** Full-state tasklist.state; the shelf never infers row lifetime. */
  tasks: readonly TaskListItem[];
  value: string;
  onValueChange(value: string): void;
  onTextSubmit(text: string): void;
  onCaptureIntent: CaptureIntentHandler;
  onTtsToggle(): void;
  onInterrupt(): void;
  onSuggestionClick(text: string): void;
}
