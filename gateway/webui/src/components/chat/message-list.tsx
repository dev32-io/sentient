import { Fragment } from "preact";
import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import type { SentientMarkMode } from "../common/sentient-mark.tsx";
import { DayDivider } from "./day-divider.tsx";
import { MessageBubble, type CurrentUser } from "./message-bubble.tsx";

export interface MessageListProps {
  messages: readonly ChatMessage[];
  currentCycleId: string | null;
  activeCycleMode: SentientMarkMode;
  currentUser: CurrentUser;
}

const DIVIDER_GAP_MS = 30 * 60 * 1000;

function formatShort(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dividerLabelFor(prev: ChatMessage | undefined, cur: ChatMessage): string | null {
  if (!prev) {
    const weekday = new Date(cur.timestamp).toLocaleDateString(undefined, { weekday: "long" });
    return `${weekday} · ${formatShort(cur.timestamp)}`;
  }
  if (cur.timestamp - prev.timestamp > DIVIDER_GAP_MS) return formatShort(cur.timestamp);
  return null;
}

export function MessageList({ messages, currentCycleId, activeCycleMode, currentUser }: MessageListProps): JSX.Element {
  if (messages.length === 0) {
    return (
      <section class="message-list message-list--empty" aria-label="Messages">
        <p class="message-list__placeholder">Start a conversation...</p>
      </section>
    );
  }
  return (
    <section class="message-list" aria-label="Messages" role="log" aria-live="polite">
      {messages.map((m, i) => {
        const divider = dividerLabelFor(messages[i - 1], m);
        const avatarMode: SentientMarkMode =
          m.role === "assistant" && m.cycleId === currentCycleId ? activeCycleMode : "idle";
        return (
          <Fragment key={m.id}>
            {divider && <DayDivider label={divider} />}
            <MessageBubble message={m} avatarMode={avatarMode} currentUser={currentUser} />
          </Fragment>
        );
      })}
    </section>
  );
}
