import { signal } from "@preact/signals";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { SessionsProvider } from "../../context/sessions.tsx";
import type { UseSessions } from "../../hooks/use-sessions.ts";
import { Drawer } from "./drawer.tsx";

function sessionsFixture(): UseSessions {
  return {
    items: signal([{ sessionId: "session-1", rootId: "session-1", title: "Earlier chat", startedAt: Date.now(), lastActiveAt: Date.now(), messageCount: 2, isActive: true }]),
    searchHits: signal(null),
    loading: signal(false),
    error: signal(null),
    currentId: signal(null),
    load: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(undefined),
    switchTo: vi.fn().mockResolvedValue(undefined),
    newChat: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

function Harness({ sessions }: { sessions: UseSessions }) {
  const [open, setOpen] = useState(false);
  return (
    <SessionsProvider value={sessions}>
      <button type="button" onClick={() => setOpen(true)}>Open history</button>
      <Drawer open={open} onClose={() => setOpen(false)} />
    </SessionsProvider>
  );
}

describe("History drawer", () => {
  it("dismisses explicitly, by Escape, and by backdrop while restoring trigger focus", async () => {
    const sessions = sessionsFixture();
    const { container } = render(<Harness sessions={sessions} />);
    const trigger = screen.getByRole("button", { name: "Open history" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Past chats" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close past chats" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(trigger);
    fireEvent.click(container.querySelector(".drawer__backdrop") as HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores prior sessions and starts a new chat through the existing session actions", async () => {
    const sessions = sessionsFixture();
    render(<Harness sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Open history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Earlier chat" }));
    await waitFor(() => expect(sessions.switchTo).toHaveBeenCalledWith("session-1"));

    fireEvent.click(screen.getByRole("button", { name: "Open history" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(sessions.newChat).toHaveBeenCalledOnce();
  });
});
