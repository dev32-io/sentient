import { signal } from "@preact/signals";
import type { SessionRow } from "@sentient/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { SessionsProvider } from "../../context/sessions.tsx";
import { Dialog } from "../common/dialog.tsx";
import type { UseSessions } from "../../hooks/use-sessions.ts";
import { Drawer } from "./drawer.tsx";

function sessionsFixture(): UseSessions {
  const searchHits = signal<SessionRow[] | null>(null);
  return {
    items: signal([{ sessionId: "session-1", rootId: "session-1", title: "Earlier chat", startedAt: Date.now(), lastActiveAt: Date.now(), messageCount: 2, isActive: true }]),
    searchHits,
    loading: signal(false),
    error: signal(null),
    currentId: signal(null),
    load: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(async (q: string) => {
      if (!q.trim()) searchHits.value = null;
    }),
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
  it("renders the saved-results stale state and keeps retry on the session loader", async () => {
    const sessions = sessionsFixture();
    sessions.error.value = "network unavailable";
    render(
      <SessionsProvider value={sessions}>
        <Drawer open onClose={() => {}} />
      </SessionsProvider>,
    );

    await waitFor(() => expect(sessions.load).toHaveBeenCalledOnce());
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Showing saved results");
    expect(banner.textContent).toContain("Couldn’t refresh just now.");
    expect(banner.querySelector("[data-state='checking']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(sessions.load).toHaveBeenCalledTimes(2);
  });

  it("derives checking from the authoritative refresh signal and disables retry", async () => {
    const sessions = sessionsFixture();
    sessions.loading.value = true;
    render(
      <SessionsProvider value={sessions}>
        <Drawer open onClose={() => {}} />
      </SessionsProvider>,
    );

    await waitFor(() => expect(sessions.load).toHaveBeenCalledOnce());
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-state")).toBe("checking");
    expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(sessions.items.value).toHaveLength(1);
  });

  it("keeps every closed drawer control out of sequential keyboard navigation", async () => {
    const sessions = sessionsFixture();
    const { container } = render(<Harness sessions={sessions} />);
    const trigger = screen.getByRole("button", { name: "Open history" });
    const drawer = container.querySelector<HTMLElement>(".drawer");

    expect(drawer?.hasAttribute("inert")).toBe(true);
    const sequentialControls = Array.from(
      container.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])"),
    ).filter((element) => !element.closest("[inert]"));
    expect(sequentialControls).toEqual([trigger]);

    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Past chats" });
    expect(drawer?.hasAttribute("inert")).toBe(false);
    const closeButton = screen.getByRole("button", { name: "Close past chats" });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));

    fireEvent.click(closeButton);
    await waitFor(() => {
      expect(drawer?.hasAttribute("inert")).toBe(true);
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("does not let a closed Drawer steal Dialog focus trapping or Escape", () => {
    const sessions = sessionsFixture();
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    render(
      <SessionsProvider value={sessions}>
        <Dialog title="Calendar" onClose={onClose}>
          <button type="button">First action</button>
        </Dialog>
        <Drawer open={false} onClose={() => {}} />
      </SessionsProvider>,
      { container: host },
    );

    const dialog = screen.getByRole("dialog", { name: "Calendar" });
    const dialogButtons = within(dialog).getAllByRole("button");
    const last = dialogButtons[dialogButtons.length - 1];
    last?.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(dialogButtons[0]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

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

  it("renders no-match recovery and clears the active search", async () => {
    const sessions = sessionsFixture();
    sessions.searchHits.value = [];
    render(<Harness sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Open history" }));

    const status = await screen.findByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("No matching results")).toBeTruthy();
    expect(screen.getByText("Try a broader term or clear one of the filters.")).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: "Search past chats" }) as HTMLInputElement;
    fireEvent.input(search, { target: { value: "unfindable" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(sessions.search).toHaveBeenCalledWith("");
      expect(screen.queryByText("No matching results")).toBeNull();
      expect(search.value).toBe("");
    });
    expect(document.activeElement).toBe(search);
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
