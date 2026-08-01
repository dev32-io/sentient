import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { ChatMessage } from "../../types.ts";
import { Icon } from "../common/icon.tsx";

export interface SystemEventRowProps {
  message: ChatMessage;
}

/** Fallback label for a stimulus source the UI has no friendlier name for —
 *  sensor and scheduled sources land here unchanged once they exist. */
const DEFAULT_LABEL = "System event";

const LABEL_BY_SOURCE: Readonly<Record<string, string>> = {
  "background-completion": "Background task",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function firstLineOf(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 0 ? line : text;
}

/**
 * A feed entry nobody typed — today a delegated task's settled result.
 *
 * Deliberately NOT a chat bubble: it has no avatar, no name and no side, so it
 * cannot be misread as either person in the conversation. That misattribution
 * is the client half of defect D16 — the gateway put the delegated result on
 * the wire, the feed walk dropped it, and the owner watched the assistant
 * acknowledge content they were never shown.
 *
 * Collapsed it shows the summary's first line (which names the task); expanded
 * it shows the whole payload, monospaced, because the point of showing it at
 * all is that the owner can read what came back.
 */
function SystemEventRowInner({ message }: SystemEventRowProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const label = (message.source && LABEL_BY_SOURCE[message.source]) ?? DEFAULT_LABEL;
  const preview = firstLineOf(message.text);
  const isTruncated = preview !== message.text;

  return (
    <article class={`system-event ${isOpen ? "system-event--open" : ""}`} aria-label={label}>
      <button
        type="button"
        class="system-event__head"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span class="system-event__icon">
          <Icon name="spark" size={13} />
        </span>
        <span class="system-event__label">{label}</span>
        <time class="system-event__time" dateTime={new Date(message.timestamp).toISOString()}>
          {formatTime(message.timestamp)}
        </time>
        {isTruncated && (
          <span class="system-event__chev">
            <Icon name="chevron" size={10} />
          </span>
        )}
      </button>
      <div class="system-event__body">{isOpen || !isTruncated ? message.text : preview}</div>
    </article>
  );
}

export const SystemEventRow = SystemEventRowInner;
