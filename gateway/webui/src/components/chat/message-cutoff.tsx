import type { JSX } from "preact";
import type { ConversationAssistantCutoff } from "@sentient/protocol";

export interface MessageCutoffProps {
  variant: "inline" | "meta";
  cutoffKind: ConversationAssistantCutoff["kind"];
}

export function MessageCutoff({ variant, cutoffKind }: MessageCutoffProps): JSX.Element {
  const label = cutoffKind === "barge-in" ? "Interrupted by a new message" : "Interrupted";
  return (
    <span class={`interrupt-chip interrupt-chip--${variant}`} role="note" aria-label={label}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}
