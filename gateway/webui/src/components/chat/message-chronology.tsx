import { Fragment } from "preact";
import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import { DayDivider } from "./day-divider.tsx";
import { MessageChronologyState } from "./message-chronology-state.tsx";
import { MessageGroup } from "./message-group.tsx";
import type { CurrentUser } from "./message-identity.tsx";
import type { MessageChronologyStatus } from "./message-types.ts";

export type { MessageChronologyStatus } from "./message-types.ts";

export interface MessageChronologyProps {
  messages: readonly ChatMessage[];
  currentTurnId: string | null;
  activeCycleState: SentientIdentityState;
  currentUser: CurrentUser;
  status?: MessageChronologyStatus;
}

const DIVIDER_GAP_MS = 30 * 60 * 1000;

function formatShort(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sameLocalDay(first: number, second: number): boolean {
  const a = new Date(first);
  const b = new Date(second);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (sameLocalDay(date.getTime(), today.getTime())) return "Today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameLocalDay(date.getTime(), yesterday.getTime())) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function dividerLabelFor(previous: ChatMessage | undefined, current: ChatMessage): string | null {
  if (!previous || !sameLocalDay(previous.timestamp, current.timestamp)) return formatDay(current.timestamp);
  if (current.timestamp - previous.timestamp > DIVIDER_GAP_MS) return formatShort(current.timestamp);
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

function isAssistantContinuation(previous: ChatMessage | undefined, current: ChatMessage, divider: string | null): boolean {
  return divider === null && previous?.role === "assistant" && current.role === "assistant";
}

export function MessageChronology({ messages, currentTurnId, activeCycleState, currentUser, status = "ready" }: MessageChronologyProps): JSX.Element {
  if (messages.length === 0) return <MessageChronologyState status={status} />;

  return (
    <section class="message-list" aria-label="Messages" role="log" aria-live="polite" aria-relevant="additions text">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const divider = dividerLabelFor(previous, message);
        const identityState = assistantStateFor(messages, index, currentTurnId, activeCycleState);
        return (
          <Fragment key={message.id}>
            {divider && <DayDivider label={divider} />}
            <MessageGroup
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
