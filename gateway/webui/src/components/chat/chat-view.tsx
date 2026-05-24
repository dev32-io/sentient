import { useRef } from "preact/hooks";
import type { JSX, RefObject } from "preact";
import type { ChatMessage } from "../../types.ts";
import { useFollowLatest } from "../../hooks/use-follow-latest.ts";
import type { SentientMarkMode } from "../common/sentient-mark.tsx";
import type { CurrentUser } from "./message-bubble.tsx";
import { MessageList } from "./message-list.tsx";

export interface ChatViewProps {
  messages: readonly ChatMessage[];
  transcript: string;
  currentCycleId: string | null;
  activeCycleMode: SentientMarkMode;
  currentUser: CurrentUser;
}

export function ChatView({
  messages,
  transcript,
  currentCycleId,
  activeCycleMode,
  currentUser,
}: ChatViewProps): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  useFollowLatest({
    scrollContainerRef: scrollRef as RefObject<HTMLElement>,
    contentRef: contentRef as RefObject<HTMLElement>,
  });

  return (
    <section class="chat-view" ref={scrollRef}>
      <div class="chat-view__content" ref={contentRef as unknown as RefObject<HTMLDivElement>}>
        <MessageList
          messages={messages}
          currentCycleId={currentCycleId}
          activeCycleMode={activeCycleMode}
          currentUser={currentUser}
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
