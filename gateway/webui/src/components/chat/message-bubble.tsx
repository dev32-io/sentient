import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import { Avatar, type AvatarTint } from "../common/avatar.tsx";
import type { SentientMarkMode } from "../common/sentient-mark.tsx";
import { BubbleSpeakingWave } from "./bubble-speaking-wave.tsx";
import { BubbleText } from "./bubble-text.tsx";
import { InterruptChip } from "./interrupt-chip.tsx";

export interface CurrentUser {
  displayName: string;
  avatarTint: AvatarTint;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  avatarMode: SentientMarkMode;
  currentUser: CurrentUser;
}

const ASSISTANT_NAME = "Sentient";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBubbleInner({ message, avatarMode, currentUser }: MessageBubbleProps): JSX.Element {
  const isSpeaking = avatarMode === "speaking";
  const { role, text, timestamp, isStreaming, cutoff } = message;
  const name = role === "user" ? currentUser.displayName : ASSISTANT_NAME;
  const userInitial = currentUser.displayName.charAt(0).toUpperCase() || "?";

  return (
    <article
      class={`message-bubble message-bubble--${role}`}
      aria-label={`${role} message`}
    >
      {role === "user" ? (
        <Avatar kind="user" initial={userInitial} tint={currentUser.avatarTint} />
      ) : (
        <Avatar kind="assistant" mode={avatarMode} />
      )}
      <div class="message-bubble__body">
        <div class="message-bubble__meta">
          <span class="message-bubble__name">{name}</span>
          <span class="message-bubble__sep">·</span>
          <time dateTime={new Date(timestamp).toISOString()}>{formatTime(timestamp)}</time>
          {cutoff && <InterruptChip variant="meta" cutoffKind={cutoff.kind} />}
        </div>
        <div class="message-bubble__text-wrap">
          <div class="message-bubble__text-inner">
            <BubbleSpeakingWave active={isSpeaking} />
            {cutoff ? (
              <BubbleText text={text} isStreaming={isStreaming} cutoff={cutoff} />
            ) : (
              <BubbleText text={text} isStreaming={isStreaming} />
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export const MessageBubble = MessageBubbleInner;
