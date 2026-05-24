import type { JSX } from "preact";
import type { ConversationAssistantCutoff } from "@sentient/protocol";
import { renderMarkdown } from "../../lib/render-markdown.ts";
import { InterruptChip } from "./interrupt-chip.tsx";

export interface BubbleTextProps {
  text: string;
  isStreaming: boolean;
  cutoff?: ConversationAssistantCutoff;
}

/**
 * Placeholder three-dot pulse rendered while the inflight bubble is waiting
 * for its first token from the LLM. Swaps out the moment the typewriter
 * emits its first character.
 */
function PlaceholderPulse(): JSX.Element {
  return (
    <span class="bubble-text__pulse" aria-label="assistant is thinking" role="status">
      <span class="bubble-text__pulse-dot" />
      <span class="bubble-text__pulse-dot" />
      <span class="bubble-text__pulse-dot" />
    </span>
  );
}

export function BubbleText({ text, isStreaming, cutoff }: BubbleTextProps): JSX.Element {
  const showPlaceholder = isStreaming && text.length === 0;
  // `bubble-text` wraps a <div> because the rendered markdown produces block
  // elements (lists, paragraphs, code blocks) that are invalid inside <p>.
  // Content is sanitized via DOMPurify inside renderMarkdown — the HTML
  // injection is safe by construction.
  const htmlProp = { __html: renderMarkdown(text) };
  return (
    <div class="bubble-text">
      {showPlaceholder ? (
        <PlaceholderPulse />
      ) : (
        <div class="bubble-text__md" dangerouslySetInnerHTML={htmlProp} />
      )}
      {cutoff && <InterruptChip variant="inline" cutoffKind={cutoff.kind} />}
    </div>
  );
}