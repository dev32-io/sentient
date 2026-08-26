import { cleanup, render, screen } from "@testing-library/preact";
import type { JSX } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types.ts";
import { MessageBubble, MessageChronology } from "./index.ts";
import type { MessageBubbleProps } from "./index.ts";

vi.mock("../common/sentient-identity.tsx", () => ({
  SentientIdentity: ({ state, label }: { state: string; label: string }): JSX.Element => (
    <span role="status" aria-label={`${label} is ${state}`} data-identity-state={state} />
  ),
}));

afterEach(cleanup);

const currentUser = { displayName: "Maya", avatarTint: "terra" as const };

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "text" | "timestamp">): ChatMessage {
  return { isStreaming: false, ...overrides };
}

describe("chat public component API", () => {
  it("accepts semantic inputs while keeping role and surface structure internal", () => {
    const semanticProps: MessageBubbleProps = {
      message: message({ id: "u1", role: "user", text: "Hello", timestamp: 1 }),
      identityState: "idle",
      currentUser,
    };
    expect(semanticProps.message.role).toBe("user");

    const { container, rerender } = render(<MessageBubble {...semanticProps} />);
    const userArticle = container.querySelector("article");
    expect(userArticle?.getAttribute("data-message-role")).toBe("user");
    expect(userArticle?.querySelector(".message-bubble__surface")).not.toBeNull();
    expect(userArticle?.querySelector(".message-bubble__text-wrap")).not.toBeNull();

    rerender(
      <MessageBubble
        message={message({ id: "a1", role: "assistant", text: "Hi", timestamp: 2 })}
        identityState="idle"
        currentUser={currentUser}
      />,
    );
    expect(container.querySelector("article")?.getAttribute("data-message-role")).toBe("assistant");
    expect(screen.getByText("Sentient")).toBeTruthy();
  });

  it("keeps streaming, cutoff, and chronology error states semantic", () => {
    const { container, rerender } = render(
      <MessageBubble
        message={message({ id: "a1", role: "assistant", text: "", timestamp: 1, isStreaming: true })}
        identityState="thinking"
        currentUser={currentUser}
      />,
    );
    expect(container.querySelector(".bubble-text__pulse")).not.toBeNull();
    expect(container.querySelector(".bubble-text__caret")).toBeNull();

    rerender(
      <MessageBubble
        message={message({ id: "a1", role: "assistant", text: "Growing", timestamp: 1, isStreaming: true })}
        identityState="responding"
        currentUser={currentUser}
      />,
    );
    expect(container.querySelector(".bubble-text__caret")).not.toBeNull();
    expect(container.querySelector(".bubble-speaking-wave")).not.toBeNull();

    rerender(
      <MessageBubble
        message={message({ id: "a1", role: "assistant", text: "Stopped", timestamp: 1, cutoff: { kind: "barge-in" } })}
        identityState="idle"
        currentUser={currentUser}
      />,
    );
    expect(container.querySelector('[data-message-state="interrupted"]')).not.toBeNull();
    expect(screen.getByRole("note", { name: "Interrupted by a new message" })).toBeTruthy();

    rerender(
      <MessageChronology
        messages={[]}
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
        status="error"
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("unavailable");
  });

  it("keeps the public API free of style hooks", () => {
    const styledProps: MessageBubbleProps = {
      message: message({ id: "u1", role: "user", text: "Hello", timestamp: 1 }),
      identityState: "idle",
      currentUser,
      // @ts-expect-error Public chat props accept semantic state, not internal styling.
      className: "custom-bubble",
    };
    expect(styledProps).toBeDefined();
  });
});
