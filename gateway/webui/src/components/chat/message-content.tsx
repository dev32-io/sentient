import type { JSX } from "preact";
import type { ConversationAssistantCutoff } from "@sentient/protocol";
import type { MarkdownImages } from "../../lib/render-markdown.ts";
import { RichMarkdown } from "./rich-markdown.tsx";
import { MessageCutoff } from "./message-cutoff.tsx";
import { StreamingCaret, ThinkingPulse } from "./streaming-presentation.tsx";

export interface MessageContentProps {
  text: string;
  isStreaming: boolean;
  images?: MarkdownImages | undefined;
  cutoff?: ConversationAssistantCutoff | undefined;
}

/**
 * The content boundary owns Markdown rendering and the transient states around
 * it. The HTML is sanitized by renderMarkdown before it reaches the DOM.
 */
export function MessageContent({
  text,
  isStreaming,
  cutoff,
  images,
}: MessageContentProps): JSX.Element {
  const showPlaceholder = isStreaming && text.length === 0;

  return (
    <div
      class={`bubble-text${showPlaceholder ? " bubble-text--thinking" : ""}`}
    >
      {showPlaceholder ? (
        <ThinkingPulse />
      ) : (
        <RichMarkdown text={text} images={images} />
      )}
      {isStreaming && text.length > 0 && <StreamingCaret />}
      {cutoff && <MessageCutoff variant="inline" cutoffKind={cutoff.kind} />}
    </div>
  );
}
