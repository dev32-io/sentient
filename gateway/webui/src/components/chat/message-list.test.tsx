import { cleanup, render, screen } from "@testing-library/preact";
import type { JSX } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types.ts";
import { MessageList, assistantStateFor, dividerLabelFor } from "./message-list.tsx";

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

describe("MessageList chronology and grouping", () => {
  it("preserves semantic chronology while suppressing repeated assistant identity", () => {
    const messages = [
      message({ id: "u1", role: "user", text: "Question", timestamp: new Date(2026, 2, 19, 18, 41).getTime() }),
      message({ id: "a1", role: "assistant", text: "First", timestamp: new Date(2026, 2, 19, 18, 42).getTime() }),
      message({ id: "a2", role: "assistant", text: "Follow-up", timestamp: new Date(2026, 2, 19, 18, 43).getTime() }),
      message({ id: "a3", role: "assistant", text: "Next day", timestamp: new Date(2026, 2, 20, 9).getTime() }),
    ];

    const view = render(<MessageList messages={messages} currentTurnId={null} activeCycleState="idle" currentUser={currentUser} />);
    const articles = screen.getAllByRole("article");

    expect(articles).toHaveLength(4);
    expect(articles[2]?.getAttribute("aria-label")).toContain("Message 3 of 4 from Sentient");
    expect(articles[2]?.classList.contains("message-bubble--continuation")).toBe(true);
    expect(articles[2]?.querySelector("[data-identity-state]")).toBeNull();
    expect(articles[3]?.querySelector("[data-identity-state]")).not.toBeNull();
    expect(view.container.querySelectorAll('[role="separator"]')).toHaveLength(2);
  });

  it("starts a new assistant group after a same-day chronology gap", () => {
    const first = message({ id: "a1", role: "assistant", text: "Earlier", timestamp: new Date(2026, 2, 19, 9).getTime() });
    const later = message({ id: "a2", role: "assistant", text: "Later", timestamp: new Date(2026, 2, 19, 10).getTime() });
    expect(dividerLabelFor(first, later)).toMatch(/10:00/);

    const { container } = render(<MessageList messages={[first, later]} currentTurnId={null} activeCycleState="idle" currentUser={currentUser} />);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(container.querySelectorAll(".message-bubble--continuation")).toHaveLength(0);
  });

  it("presents loading, empty, and error states inside chat content", () => {
    const view = render(<MessageList messages={[]} currentTurnId={null} activeCycleState="idle" currentUser={currentUser} status="loading" />);
    expect(screen.getByRole("status").textContent).toContain("Loading conversation");
    view.rerender(<MessageList messages={[]} currentTurnId={null} activeCycleState="idle" currentUser={currentUser} status="error" />);
    expect(screen.getByRole("status").textContent).toContain("unavailable");
    view.rerender(<MessageList messages={[]} currentTurnId={null} activeCycleState="idle" currentUser={currentUser} />);
    expect(screen.getByText("Start a conversation…")).toBeTruthy();
  });
});

describe("assistant identity state", () => {
  it("maps empty streaming to thinking, first text/playback to responding, and only activates the latest matching row", () => {
    const rows = [
      message({ id: "a1", role: "assistant", text: "Earlier", timestamp: 1, turnId: "turn", isStreaming: false }),
      message({ id: "a2", role: "assistant", text: "", timestamp: 2, turnId: "turn", isStreaming: true }),
    ];
    expect(assistantStateFor(rows, 0, "turn", "thinking")).toBe("idle");
    expect(assistantStateFor(rows, 1, "turn", "responding")).toBe("thinking");
    expect(assistantStateFor([{ ...rows[1]!, text: "First token" }], 0, "turn", "thinking")).toBe("responding");
    expect(assistantStateFor([{ ...rows[0]!, cutoff: { kind: "interrupt", cancelledTaskIds: [] } }], 0, "turn", "responding")).toBe("idle");
  });

  it("exposes text-only thinking, responding, completed, and interrupted selectors", () => {
    const states = [
      message({ id: "thinking", role: "assistant", text: "", timestamp: 1, turnId: "t", isStreaming: true }),
      message({ id: "responding", role: "assistant", text: "Growing", timestamp: 2, turnId: "r", isStreaming: true }),
      message({ id: "completed", role: "assistant", text: "Done", timestamp: 3 }),
      message({ id: "interrupted", role: "assistant", text: "Stopped", timestamp: 4, cutoff: { kind: "interrupt", cancelledTaskIds: [] } }),
    ];

    const { container, rerender } = render(<MessageList messages={[states[0]!]} currentTurnId="t" activeCycleState="thinking" currentUser={currentUser} />);
    expect(container.querySelector('[data-message-state="thinking"]')).not.toBeNull();
    rerender(<MessageList messages={[states[1]!]} currentTurnId="r" activeCycleState="thinking" currentUser={currentUser} />);
    expect(container.querySelector('[data-message-state="responding"]')).not.toBeNull();
    rerender(<MessageList messages={[states[2]!]} currentTurnId={null} activeCycleState="idle" currentUser={currentUser} />);
    expect(container.querySelector('[data-message-state="completed"]')).not.toBeNull();
    rerender(<MessageList messages={[states[3]!]} currentTurnId="x" activeCycleState="responding" currentUser={currentUser} />);
    expect(container.querySelector('[data-message-state="interrupted"]')).not.toBeNull();
    expect(screen.getAllByRole("note", { name: "Interrupted" })).toHaveLength(1);
  });
});

describe("message content boundary", () => {
  it("renders sanitized Markdown, scrollable code structure, long tokens, and no task pills", () => {
    const longToken = "x".repeat(180);
    const text = `## Safe\n[link](https://example.com)\n\n\`\`\`txt\n${longToken}\n\`\`\`\n<script>bad()</script>`;
    const { container } = render(
      <MessageList
        messages={[message({ id: "a", role: "assistant", text, timestamp: 1 })]}
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );

    expect(container.querySelector("h2")?.textContent).toBe("Safe");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(container.querySelector("pre code")?.textContent).toContain(longToken);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".tool-pill, .tool-inline-detail, [data-task]")).toBeNull();
  });
});
