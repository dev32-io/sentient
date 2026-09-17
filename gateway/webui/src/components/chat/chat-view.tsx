import { useLayoutEffect, useRef } from "preact/hooks";
import type { JSX, RefObject } from "preact";
import type { ChatMessage } from "../../types.ts";
import { useFollowLatest } from "../../hooks/use-follow-latest.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import {
  MessageChronology,
  type CurrentUser,
  type MessageChronologyStatus,
} from "./index.ts";

export interface ChatViewProps {
  messages: readonly ChatMessage[];
  localSendIds?: readonly string[];
  transcript: string;
  currentTurnId: string | null;
  activeCycleState: SentientIdentityState;
  currentUser: CurrentUser;
  status?: MessageChronologyStatus;
}

export function ChatView({
  messages,
  localSendIds = [],
  transcript,
  currentTurnId,
  activeCycleState,
  currentUser,
  status = "ready",
}: ChatViewProps): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const { anchorTo, cancelAnchor, releaseAnchor } = useFollowLatest({
    scrollContainerRef: scrollRef as RefObject<HTMLElement>,
    contentRef: contentRef as RefObject<HTMLElement>,
  });
  const seenMessageKeysRef = useRef<Set<string> | null>(null);
  const seenLocalSendIdsRef = useRef(new Set<string>());
  const anchoredSendIdsRef = useRef(new Set<string>());
  const ownedTailPxRef = useRef(0);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const rows = [
      ...content.querySelectorAll<HTMLElement>("[data-message-key]"),
    ];
    if (rows.length === 0) {
      seenLocalSendIdsRef.current.clear();
      anchoredSendIdsRef.current.clear();
      ownedTailPxRef.current = 0;
      releaseAnchor(seenMessageKeysRef.current?.size ? 0 : undefined);
      content.style.removeProperty("--chat-owned-tail");
      seenMessageKeysRef.current = new Set();
      return;
    }
    const keys = new Set(rows.map((row) => row.dataset.messageKey ?? ""));
    const seen = seenMessageKeysRef.current;
    if (seen) {
      for (const row of rows) {
        const key = row.dataset.messageKey ?? "";
        if (seen.has(key)) continue;
        row.classList.add("message-bubble--entering");
        row.addEventListener(
          "animationend",
          () => row.classList.remove("message-bubble--entering"),
          { once: true },
        );
      }
    }
    seenMessageKeysRef.current = keys;
    if (!seen) {
      for (const id of localSendIds) {
        seenLocalSendIdsRef.current.add(id);
        anchoredSendIdsRef.current.add(id);
      }
      return; // Initial/history hydration establishes baseline; it never moves viewport.
    }

    const newSendIds = localSendIds.filter(
      (id) => !seenLocalSendIdsRef.current.has(id),
    );
    if (newSendIds.length > 0) {
      for (const id of newSendIds) seenLocalSendIdsRef.current.add(id);
      cancelAnchor();
    }
    const pending = new Set(
      localSendIds.filter((id) => !anchoredSendIdsRef.current.has(id)),
    );
    const localRows = rows.filter(
      (row) => row.dataset.pendingId && pending.has(row.dataset.pendingId),
    );
    const target = localRows.at(-1);
    if (!target) return;
    for (const row of localRows)
      anchoredSendIdsRef.current.add(row.dataset.pendingId!);
    const scroller = scrollRef.current;
    if (!scroller) return;
    const firstMessage = rows.length === 1;
    const resolveTop = () => {
      if (firstMessage) return 0;
      const scrollerRect = scroller.getBoundingClientRect();
      const dock = scroller
        .closest(".app-shell")
        ?.querySelector<HTMLElement>(".app-shell__dock");
      const dockClearance = dock
        ? Math.max(0, scrollerRect.bottom - dock.getBoundingClientRect().top)
        : Number.parseFloat(
            getComputedStyle(scroller).getPropertyValue(
              "--chat-bottom-clear",
            ),
          ) || 0;
      const transform = getComputedStyle(target).transform;
      const entranceOffset =
        !transform || transform === "none"
          ? 0
          : new DOMMatrixReadOnly(transform).m42;
      const top =
        target.getBoundingClientRect().top -
        entranceOffset -
        scrollerRect.top +
        scroller.scrollTop -
        Math.max(0, scroller.clientHeight - dockClearance) * 0.2;
      const maxWithoutOwnedTail = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight - ownedTailPxRef.current,
      );
      ownedTailPxRef.current = Math.max(0, top - maxWithoutOwnedTail);
      content.style.setProperty(
        "--chat-owned-tail",
        `${ownedTailPxRef.current}px`,
      );
      return top;
    };
    const reduceMotion =
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
      false;
    anchorTo(resolveTop, !reduceMotion);
  }, [anchorTo, cancelAnchor, localSendIds, messages, releaseAnchor, status]);

  return (
    <section
      class="chat-view"
      ref={scrollRef}
      aria-label="Conversation content"
    >
      <div
        class="chat-view__content"
        ref={contentRef as unknown as RefObject<HTMLDivElement>}
      >
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
