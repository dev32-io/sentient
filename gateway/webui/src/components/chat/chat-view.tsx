import { useRef } from "preact/hooks";
import type { JSX, RefObject } from "preact";
import type { ChatMessage } from "../../types.ts";
import { useFollowLatest } from "../../hooks/use-follow-latest.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import { MessageChronology, type CurrentUser, type MessageChronologyStatus } from "./index.ts";

export interface ChatViewProps {
  messages: readonly ChatMessage[];
  transcript: string;
  currentTurnId: string | null;
  activeCycleState: SentientIdentityState;
  currentUser: CurrentUser;
  status?: MessageChronologyStatus;
}

export function ChatView({
  messages,
  transcript,
  currentTurnId,
  activeCycleState,
  currentUser,
  status = "ready",
}: ChatViewProps): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  useFollowLatest({
    scrollContainerRef: scrollRef as RefObject<HTMLElement>,
    contentRef: contentRef as RefObject<HTMLElement>,
  });

  return (
    <section class="chat-view" ref={scrollRef} aria-label="Conversation content">
      <div class="chat-view__content" ref={contentRef as unknown as RefObject<HTMLDivElement>}>
        <MessageChronology
          messages={messages}
          currentTurnId={currentTurnId}
          activeCycleState={activeCycleState}
          currentUser={currentUser}
          status={status}
        />
        {transcript && (
          <div class="chat-view__transcript" aria-label="Live transcript">
            {transcript}
          </div>
        )}
      </div>
    </section>
  );
}
