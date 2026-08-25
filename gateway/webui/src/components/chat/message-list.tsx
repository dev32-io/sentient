import { Fragment } from "preact";
import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import { DayDivider } from "./day-divider.tsx";
import { MessageBubble, type CurrentUser } from "./message-bubble.tsx";

export type MessageListStatus = "ready" | "loading" | "error";

export interface MessageListProps {
  messages: readonly ChatMessage[];
  currentTurnId: string | null;
  activeCycleState: SentientIdentityState;
  currentUser: CurrentUser;
  status?: MessageListStatus;
}

const DIVIDER_GAP_MS = 30 * 60 * 1000;

function formatShort(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sameLocalDay(first: number, second: number): boolean {
  const a = new Date(first);
  const b = new Date(second);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDay(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  if (sameLocalDay(date.getTime(), today.getTime())) return "Today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameLocalDay(date.getTime(), yesterday.getTime())) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function dividerLabelFor(prev: ChatMessage | undefined, cur: ChatMessage): string | null {
  if (!prev || !sameLocalDay(prev.timestamp, cur.timestamp)) return formatDay(cur.timestamp);
  if (cur.timestamp - prev.timestamp > DIVIDER_GAP_MS) return formatShort(cur.timestamp);
  return null;
}

/** Only the newest assistant row belonging to the active turn carries identity state. */
export function assistantStateFor(
  messages: readonly ChatMessage[],
  index: number,
  currentTurnId: string | null,
  activeCycleState: SentientIdentityState,
): SentientIdentityState {
  const message = messages[index];
  if (!message || message.role !== "assistant" || message.cutoff || !currentTurnId || message.turnId !== currentTurnId) return "idle";

  let latestActiveIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate?.role === "assistant" && candidate.turnId === currentTurnId) {
      latestActiveIndex = i;
      break;
    }
  }
  if (index !== latestActiveIndex) return "idle";
  if (message.isStreaming) return message.text.length > 0 ? "responding" : "thinking";
  return activeCycleState;
}

function isAssistantContinuation(previous: ChatMessage | undefined, message: ChatMessage, divider: string | null): boolean {
  return divider === null && previous?.role === "assistant" && message.role === "assistant";
}

export function MessageList({ messages, currentTurnId, activeCycleState, currentUser, status = "ready" }: MessageListProps): JSX.Element {
  if (messages.length === 0) {
    const label = status === "loading" ? "Loading conversation…" : status === "error" ? "Conversation is unavailable. Reconnect to try again." : "Start a conversation…";
    return (
      <section class={`message-list message-list--empty message-list--${status}`} aria-label="Messages">
        <p class="message-list__placeholder" role={status === "ready" ? undefined : "status"}>{label}</p>
      </section>
    );
  }
  return (
    <section class="message-list" aria-label="Messages" role="log" aria-live="polite" aria-relevant="additions text">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const divider = dividerLabelFor(previous, message);
        const identityState = assistantStateFor(messages, index, currentTurnId, activeCycleState);
        return (
          <Fragment key={message.id}>
            {divider && <DayDivider label={divider} />}
            <MessageBubble
              message={message}
              identityState={identityState}
              currentUser={currentUser}
              continuation={isAssistantContinuation(previous, message, divider)}
              position={index + 1}
              total={messages.length}
            />
          </Fragment>
        );
      })}
    </section>
  );
}
