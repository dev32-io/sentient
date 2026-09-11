import type { JSX } from "preact";
import type { ConversationAssistantCutoff } from "@sentient/protocol";
import { renderMarkdown } from "../../lib/render-markdown.ts";
import { MessageCutoff } from "./message-cutoff.tsx";
import { StreamingCaret, ThinkingPulse } from "./streaming-presentation.tsx";

export interface MessageContentProps {
  text: string;
  isStreaming: boolean;
  cutoff?: ConversationAssistantCutoff | undefined;
}

/**
 * The content boundary owns Markdown rendering and the transient states around
 * it. The HTML is sanitized by renderMarkdown before it reaches the DOM.
 */
export function MessageContent({ text, isStreaming, cutoff }: MessageContentProps): JSX.Element {
  const showPlaceholder = isStreaming && text.length === 0;
  const htmlProp = { __html: renderMarkdown(text) };

  return (
    <div class="bubble-text">
      {showPlaceholder ? <ThinkingPulse /> : <div class="bubble-text__md" dangerouslySetInnerHTML={htmlProp} />}
      {isStreaming && text.length > 0 && <StreamingCaret />}
      {cutoff && <MessageCutoff variant="inline" cutoffKind={cutoff.kind} />}
    </div>
  );
}
