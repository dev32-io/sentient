import type { ComponentChildren, JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import type { MessageVisualState } from "./message-state.ts";

export interface MessageBubbleFrameProps {
  message: ChatMessage;
  name: string;
  identity: ComponentChildren;
  content: ComponentChildren;
  surfaceEffect?: ComponentChildren;
  state?: MessageVisualState | undefined;
  continuation: boolean;
  position?: number | undefined;
  total?: number | undefined;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageBubbleFrame({ message, name, identity, content, surfaceEffect, state, continuation, position, total }: MessageBubbleFrameProps): JSX.Element {
  const chronology = position !== undefined && total !== undefined ? `Message ${position} of ${total}` : "Message";
  const cutoffLabel = message.cutoff ? ", interrupted" : "";

  return (
    <article
      class={`message-bubble message-bubble--${message.role}${continuation ? " message-bubble--continuation" : ""}`}
      aria-label={`${chronology} from ${name} at ${formatTime(message.timestamp)}${cutoffLabel}`}
      data-message-role={message.role}
      data-message-state={state}
    >
      {identity}
      <div class="message-bubble__body">
        {!continuation && (
          <header class="message-bubble__meta">
            <span class="message-bubble__name">{name}</span>
            <span class="message-bubble__sep" aria-hidden="true">·</span>
            <time dateTime={new Date(message.timestamp).toISOString()}>{formatTime(message.timestamp)}</time>
          </header>
        )}
        <div class="message-bubble__text-wrap">
          <span class="message-bubble__surface" aria-hidden="true">{surfaceEffect}</span>
          <div class="message-bubble__text-inner">{content}</div>
        </div>
      </div>
    </article>
  );
}
