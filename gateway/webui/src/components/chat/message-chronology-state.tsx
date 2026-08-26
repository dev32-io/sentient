import type { JSX } from "preact";
import type { MessageChronologyStatus } from "./message-types.ts";

export interface MessageChronologyStateProps {
  status: MessageChronologyStatus;
}

export function MessageChronologyState({ status }: MessageChronologyStateProps): JSX.Element {
  const label = status === "loading"
    ? "Loading conversation…"
    : status === "error"
      ? "Conversation is unavailable. Reconnect to try again."
      : "Start a conversation…";
  return (
    <section class={`message-list message-list--empty message-list--${status}`} aria-label="Messages">
      <p class="message-list__placeholder" role={status === "ready" ? undefined : "status"}>{label}</p>
    </section>
  );
}
