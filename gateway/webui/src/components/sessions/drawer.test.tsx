import { signal } from "@preact/signals";
import type { SessionRow } from "@sentient/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { SessionsProvider } from "../../context/sessions.tsx";
import { Dialog } from "../common/dialog.tsx";
import type { UseSessions } from "../../hooks/use-sessions.ts";
import { Drawer } from "./drawer.tsx";
import { useSettingsDeparture } from "../shell/settings-departure.tsx";

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
    switchTo: vi.fn().mockResolvedValue(true),
    newChat: vi.fn().mockResolvedValue(true),
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

function DepartureHarness({ sessions }: { sessions: UseSessions }) {
  const departure = useSettingsDeparture();
  const [open, setOpen] = useState(true);
  useEffect(() => departure.onStateChange({ dirty: true, busy: false }), [departure.onStateChange]);
  return (
    <SessionsProvider value={sessions}>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        onBeforeSessionChange={async () => {
          await Promise.resolve();
          return departure.request();
        }}
      />
      {departure.dialog}
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
    await waitFor(() => {
      expect(sessions.switchTo).toHaveBeenCalledWith("session-1");
      expect(screen.queryByRole("dialog", { name: "Past chats" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open history" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(sessions.newChat).toHaveBeenCalledOnce();
  });

  it("marks the current row accessibly without exposing unavailable actions", () => {
    const sessions = sessionsFixture();
    sessions.currentId.value = "session-1";
    render(<SessionsProvider value={sessions}><Drawer open onClose={() => {}} /></SessionsProvider>);
    expect(screen.getByRole("button", { name: "Earlier chat Current" }).getAttribute("aria-current")).toBe("true");
    expect(screen.queryByRole("button", { name: "Chat options" })).toBeNull();
  });

  it.each(["Earlier chat", "New chat"])("guards %s before effects, blocks duplicates and navigates only after success", async (label) => {
    const sessions = sessionsFixture();
    let allow!: (value: boolean) => void;
    let finish!: (value: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { allow = resolve; }));
    const operation = label === "New chat" ? sessions.newChat : sessions.switchTo;
    vi.mocked(operation).mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const selected = vi.fn();
    const close = vi.fn();
    render(<SessionsProvider value={sessions}><Drawer open onClose={close} onBeforeSessionChange={guard} onSessionSelected={selected} /></SessionsProvider>);

    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(guard).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    allow(false);
    await waitFor(() => expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false));
    expect(operation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: label }));
    allow(true);
    await waitFor(() => expect(operation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: label === "New chat" ? "Earlier chat" : "New chat" }));
    expect(guard).toHaveBeenCalledTimes(2);
    expect(selected).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    finish(true);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(selected).toHaveBeenCalledOnce();
    expect(selected.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
  });

  it.each(["Earlier chat", "New chat"])("keeps %s failure visible and allows retry without navigating", async (label) => {
    const sessions = sessionsFixture();
    const operation = label === "New chat" ? sessions.newChat : sessions.switchTo;
    vi.mocked(operation).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const close = vi.fn();
    const selected = vi.fn();
    render(<SessionsProvider value={sessions}><Drawer open onClose={close} onSessionSelected={selected} /></SessionsProvider>);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't open chat");
    expect(close).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers from a rejected guard without starting session effects", async () => {
    const sessions = sessionsFixture();
    const close = vi.fn();
    render(<SessionsProvider value={sessions}><Drawer open onClose={close} onBeforeSessionChange={async () => { throw new Error("guard unavailable"); }} /></SessionsProvider>);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await screen.findByRole("alert");
    expect(sessions.newChat).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the action-owned drawer visible through deferred session completion", async () => {
    const sessions = sessionsFixture();
    let finish!: (value: boolean) => void;
    vi.mocked(sessions.newChat).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const close = vi.fn();
    const { container } = render(<SessionsProvider value={sessions}><Drawer open onClose={close} /></SessionsProvider>);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    const closeButton = screen.getByRole("button", { name: "Close past chats" }) as HTMLButtonElement;
    expect(closeButton.disabled).toBe(true);
    fireEvent.click(closeButton);
    fireEvent.click(container.querySelector(".drawer__backdrop")!);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    finish(true);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it.each([
    ["guard", "unmount"], ["operation", "unmount"],
    ["guard", "close"], ["operation", "close"],
    ["guard", "context replacement"], ["operation", "context replacement"],
  ] as const)("fences deferred %s completion after %s", async (stage, boundary) => {
    const sessions = sessionsFixture();
    let finish!: (value: boolean) => void;
    const deferred = () => new Promise<boolean>((resolve) => { finish = resolve; });
    const guard = stage === "guard" ? deferred : undefined;
    if (stage === "operation") vi.mocked(sessions.newChat).mockImplementation(deferred);
    const close = vi.fn();
    const selected = vi.fn();
    const draw = (open: boolean, value = sessions) => (
      <SessionsProvider value={value}>
        <Drawer open={open} onClose={close} onSessionSelected={selected} {...(guard ? { onBeforeSessionChange: guard } : {})} />
      </SessionsProvider>
    );
    const view = render(draw(true));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    if (boundary === "unmount") view.unmount();
    else if (boundary === "close") {
      view.rerender(draw(false));
      view.rerender(draw(true));
    } else view.rerender(draw(true, sessionsFixture()));
    finish(true);
    // Flush both the guard and operation continuations, not just one microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selected).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(sessions.newChat).toHaveBeenCalledTimes(stage === "operation" ? 1 : 0);
  });

  it.each([
    ["Earlier chat", "Stay"], ["New chat", "Stay"],
    ["Earlier chat", "Escape"], ["New chat", "Escape"],
  ])("restores enabled %s focus after actual settings-departure %s", async (label, dismissal) => {
    const sessions = sessionsFixture();
    render(<DepartureHarness sessions={sessions} />);
    const trigger = screen.getByRole("button", { name: label }) as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(trigger.disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay", exact: true })));
    if (dismissal === "Stay") fireEvent.click(screen.getByRole("button", { name: "Stay", exact: true }));
    else fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
      expect(trigger.disabled).toBe(false);
      expect(document.activeElement).toBe(trigger);
    });
    expect(screen.getByRole("dialog", { name: "Past chats" })).toBeTruthy();
    expect(sessions.switchTo).not.toHaveBeenCalled();
    expect(sessions.newChat).not.toHaveBeenCalled();
  });

});
