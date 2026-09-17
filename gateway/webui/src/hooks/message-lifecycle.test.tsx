import { cleanup, render } from "@testing-library/preact";
import {
  ConversationHistoryConnector,
  type InFlightMessage,
  InFlightMessageConnector,
  type SentientSDKInternal,
} from "@sentient/web-sdk";
import type { JSX } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageChronology } from "../components/chat/index.ts";
import type { ChatMessage } from "../types.ts";
import {
  type InflightPresentation,
  deriveMessages,
  updateInflightPresentations,
} from "./cycle-helpers.ts";

vi.mock("../components/common/sentient-identity.tsx", () => ({
  SentientIdentity: (): JSX.Element => <span />,
}));

afterEach(cleanup);

function createWire(): SentientSDKInternal & { emit(type: string, message: unknown): void } {
  const handlers = new Map<string, Set<(message: unknown) => void>>();
  return {
    send() {},
    sendBinary() {},
    onBinary: () => () => {},
    onMessage(type, handler) {
      const listeners = handlers.get(type) ?? new Set();
      listeners.add(handler);
      handlers.set(type, listeners);
      return () => listeners.delete(handler);
    },
    emit(type, message) {
      for (const handler of handlers.get(type) ?? []) handler(message);
    },
  };
}

const currentUser = { displayName: "Maya", avatarTint: "terra" as const };

describe("web message lifecycle", () => {
  it("keeps one DOM row through zero-delta placeholder → stamped entry → completed ordering", () => {
    const wire = createWire();
    const presentations = new Map<string, InflightPresentation>();
    let committed = [] as Parameters<typeof deriveMessages>[0];
    let inflight: readonly InFlightMessage[] = [];
    let messages: readonly ChatMessage[] = [];
    const view = render(
      <MessageChronology
        messages={messages}
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
        status="ready"
      />,
    );
    const refresh = () => {
      messages = deriveMessages(committed, inflight, undefined, undefined, presentations);
      view.rerender(
        <MessageChronology
          messages={messages}
          currentTurnId={inflight.at(-1)?.turnId ?? null}
          activeCycleState={inflight.length ? "responding" : "idle"}
          currentUser={currentUser}
          status="ready"
        />,
      );
    };
    new ConversationHistoryConnector({
      onUpdate(items) {
        committed = items;
        refresh();
      },
    }).attach(wire);
    new InFlightMessageConnector({
      onUpdate(next) {
        updateInflightPresentations(presentations, inflight, next, 100);
        inflight = next;
        refresh();
      },
    }).attach(wire);

    wire.emit("turn.started", { type: "turn.started", turnId: "t1", trigger: "user" });
    const placeholder = view.container.querySelector<HTMLElement>('[data-message-role="assistant"]')!;
    const key = placeholder.dataset.messageKey;
    const time = placeholder.querySelector("time")?.dateTime;

    // Runtime publishes a stamped failure entry before the terminal frame even
    // when no text delta ever arrived.
    wire.emit("conversation.entry", {
      type: "conversation.entry",
      turnId: "t1",
      replyId: "r1",
      item: { entryId: "12", ts: 999, kind: "assistant", content: "Something went wrong", replyId: "r1" },
    });
    expect(presentations.get("r1")).toBe(presentations.get("t1"));
    expect(view.container.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-message-role="assistant"]')).toBe(placeholder);

    wire.emit("turn.completed", { type: "turn.completed", turnId: "t1" });
    const completed = view.container.querySelector<HTMLElement>('[data-message-role="assistant"]')!;
    expect(completed).toBe(placeholder);
    expect(completed.dataset.messageKey).toBe(key);
    expect(completed.querySelector("time")?.dateTime).toBe(time);
    expect(completed.dataset.messageState).toBe("completed");

    wire.emit("turn.started", { type: "turn.started", turnId: "t2", trigger: "user" });
    wire.emit("turn.text.delta", { type: "turn.text.delta", turnId: "t2", replyId: "r2", text: "Later" });
    const rows = view.container.querySelectorAll<HTMLElement>('[data-message-role="assistant"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(completed);
    expect(rows[1]).not.toBe(completed);
  });
});
