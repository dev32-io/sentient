import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import { Avatar, type AvatarTint } from "../common/avatar.tsx";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import { BubbleSpeakingWave } from "./bubble-speaking-wave.tsx";
import { BubbleText } from "./bubble-text.tsx";

export interface CurrentUser {
  displayName: string;
  avatarTint: AvatarTint;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  identityState: SentientIdentityState;
  currentUser: CurrentUser;
  continuation?: boolean;
  position?: number;
  total?: number;
}

const ASSISTANT_NAME = "Sentient";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function messageState(message: ChatMessage, identityState: SentientIdentityState): "thinking" | "responding" | "completed" | "interrupted" {
  if (message.cutoff) return "interrupted";
  if (identityState === "thinking") return "thinking";
  if (identityState === "responding") return "responding";
  return "completed";
}

export function MessageBubble({ message, identityState, currentUser, continuation = false, position, total }: MessageBubbleProps): JSX.Element {
  const { role, text, timestamp, isStreaming, cutoff } = message;
  const name = role === "user" ? currentUser.displayName : ASSISTANT_NAME;
  const userInitial = currentUser.displayName.charAt(0).toUpperCase() || "?";
  const chronology = position && total ? `Message ${position} of ${total}` : "Message";
  const state = role === "assistant" ? messageState(message, identityState) : undefined;

  return (
    <article
      class={`message-bubble message-bubble--${role}${continuation ? " message-bubble--continuation" : ""}`}
      aria-label={`${chronology} from ${name} at ${formatTime(timestamp)}${cutoff ? ", interrupted" : ""}`}
      data-message-role={role}
      data-message-state={state}
    >
      {continuation ? (
        <span class="message-bubble__avatar-spacer" aria-hidden="true" />
      ) : role === "user" ? (
        <Avatar kind="user" initial={userInitial} name={currentUser.displayName} tint={currentUser.avatarTint} size="lg" />
      ) : (
        <Avatar kind="assistant" mode={identityState} name={ASSISTANT_NAME} size="lg" />
      )}
      <div class="message-bubble__body">
        {!continuation && (
          <header class="message-bubble__meta">
            <span class="message-bubble__name">{name}</span>
            <span class="message-bubble__sep" aria-hidden="true">·</span>
            <time dateTime={new Date(timestamp).toISOString()}>{formatTime(timestamp)}</time>
          </header>
        )}
        <div class="message-bubble__text-wrap">
          <span class="message-bubble__surface" aria-hidden="true" />
          <div class="message-bubble__text-inner">
            <BubbleSpeakingWave active={identityState === "responding"} />
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
