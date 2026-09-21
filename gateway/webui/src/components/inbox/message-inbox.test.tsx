import { signal } from "@preact/signals";
import type { ScheduledSessionCard, ScheduledSessionCardPage } from "@sentient/protocol";
import { goldenScheduleWireFixtures } from "@sentient/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { SessionsProvider } from "../../context/sessions.tsx";
import type { UseSessions } from "../../hooks/use-sessions.ts";
import type { ScheduleApiResult, SchedulesApi } from "../../services/schedules-api.ts";
import { MessageInbox } from "./message-inbox.tsx";

const firstCard = goldenScheduleWireFixtures.cards.cards[0] as ScheduledSessionCard;

function card(index: number): ScheduledSessionCard {
  return {
    ...firstCard,
    sessionId: `session-${index}`,
    scheduleId: `schedule-${index}`,
    occurrenceId: `occurrence-${index}`,
    preview: `Message ${index}`,
    completedAt: new Date(Date.parse(firstCard.completedAt) - index * 1_000).toISOString(),
  };
}

function sessions(ok = true): UseSessions {
  return {
    items: signal([]),
    drafts: signal([]),
    searchHits: signal(null),
    loading: signal(false),
    error: signal(null),
    deleteFailureCount: signal(0),
    currentId: signal(null),
    load: vi.fn(),
    search: vi.fn(),
    switchTo: vi.fn().mockResolvedValue(ok),
    openDraft: vi.fn().mockResolvedValue(ok),
    newChat: vi.fn(),
    delete: vi.fn(),
    retryFailedDeletes: vi.fn(),
    rename: vi.fn(),
    dispose: vi.fn(),
  };
}

function apiFor(cards: readonly ScheduledSessionCard[] = [firstCard]): SchedulesApi {
  return {
    cards: vi.fn().mockResolvedValue({ ok: true, value: { cards } }),
    clearCard: vi.fn().mockResolvedValue({ ok: true, value: { cleared: true } }),
    clearCards: vi.fn().mockResolvedValue({ ok: true, value: { cleared: true } }),
    list: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as SchedulesApi;
}

function view(options: {
  api?: SchedulesApi;
  sessionState?: UseSessions;
  token?: string;
  open?: boolean;
  onClose?: () => void;
  onOpenedSession?: () => void;
} = {}) {
  const sessionState = options.sessionState ?? sessions();
  const api = options.api ?? apiFor();
  const onClose = options.onClose ?? vi.fn();
  const onOpenedSession = options.onOpenedSession ?? vi.fn();
  const renderInbox = (token = options.token ?? "token", open = options.open ?? true) => (
    <SessionsProvider value={sessionState}>
      <MessageInbox open={open} token={token} api={api} onClose={onClose} onOpenedSession={onOpenedSession} />
    </SessionsProvider>
  );
  return { ...render(renderInbox()), api, sessionState, onClose, onOpenedSession, renderInbox };
}

function okPage(value: ScheduledSessionCardPage): ScheduleApiResult<ScheduledSessionCardPage> {
  return { ok: true, value };
}

const failed = { ok: false, error: { status: 503, code: "unavailable", message: "Unavailable", retryable: true } } as const;

function pointer(target: Element, type: "pointerdown" | "pointerup", init: { pointerId: number; clientX: number; clientY: number }): void {
  const event = new MouseEvent(type === "pointerdown" ? "PointerDown" : "PointerUp", { bubbles: true, clientX: init.clientX, clientY: init.clientY });
  Object.defineProperties(event, { pointerId: { value: init.pointerId }, isPrimary: { value: true } });
  fireEvent(target, event);
}

describe("scheduled message inbox", () => {
  it("opens an existing session, then keeps a clear failure visible and retries without another activation", async () => {
    const api = apiFor();
    vi.mocked(api.clearCard).mockResolvedValueOnce(failed).mockResolvedValueOnce({ ok: true, value: { cleared: true } });
    const onClose = vi.fn();
    const onOpenedSession = vi.fn();
    const sessionState = sessions();
    view({ api, sessionState, onClose, onOpenedSession });

    fireEvent.click(await screen.findByRole("button", { name: /Open scheduled message/ }));
    expect(await screen.findByText("Conversation opened, but this inbox entry remains.")).toBeTruthy();
    expect(sessionState.switchTo).toHaveBeenCalledWith(firstCard.sessionId);
    expect(onOpenedSession).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(firstCard.preview ?? "")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try clearing again" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.clearCard).toHaveBeenCalledTimes(2);
    expect(sessionState.switchTo).toHaveBeenCalledTimes(1);
  });

  it("does not clear or close when session activation fails", async () => {
    const api = apiFor();
    const onClose = vi.fn();
    const sessionState = sessions(false);
    view({ api, sessionState, onClose });

    fireEvent.click(await screen.findByRole("button", { name: /Open scheduled message/ }));
    await waitFor(() => expect(sessionState.switchTo).toHaveBeenCalledOnce());
    expect(api.clearCard).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(firstCard.preview ?? "")).toBeTruthy();
  });

  it("uses a separate accessible quiet corner action without opening the card", async () => {
    const api = apiFor();
    const sessionState = sessions();
    view({ api, sessionState });

    const open = await screen.findByRole("button", { name: /Open scheduled message/ });
    const row = open.closest("li");
    if (!row) throw new Error("expected card row");
    const clear = within(row).getByRole("button", { name: /Clear notification from/ });

    expect(clear.classList.contains("snt-icon-button")).toBe(true);
    expect(clear.classList.contains("snt-button--quiet")).toBe(true);
    expect(clear.getAttribute("title")).toBe(clear.getAttribute("aria-label"));
    expect(open.contains(clear)).toBe(false);
    expect(within(row).queryByText("Clear")).toBeNull();

    fireEvent.click(clear);
    await waitFor(() => expect(api.clearCard).toHaveBeenCalledWith("token", firstCard.sessionId, expect.any(AbortSignal)));
    expect(sessionState.switchTo).not.toHaveBeenCalled();
  });

  it("cancels clear-all safely, then confirms one account-wide action without loading later pages", async () => {
    const later = card(2);
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [firstCard], nextCursor: "page-2" }))
      .mockResolvedValueOnce(okPage({ cards: [later] }));
    view({ api });

    const clearAllTrigger = await screen.findByRole("button", { name: "Clear all" });
    fireEvent.click(clearAllTrigger);
    let dialog = screen.getByRole("dialog", { name: "Clear all messages?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    expect(api.clearCards).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(clearAllTrigger));

    fireEvent.click(clearAllTrigger);
    dialog = screen.getByRole("dialog", { name: "Clear all messages?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" }));

    await screen.findByText(later.preview ?? "");
    expect(api.clearCards).toHaveBeenCalledWith("token", [firstCard.occurrenceId], expect.any(AbortSignal));
    expect(api.cards).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.cards).mock.calls.every((call) => call[1] === undefined)).toBe(true);
  });

  it("reveals Clear on horizontal swipe, suppresses its click, and leaves vertical movement to normal activation", async () => {
    const sessionState = sessions();
    view({ api: apiFor([card(1), card(2)]), sessionState });
    const cards = await screen.findAllByRole("button", { name: /Open scheduled message/ });
    const horizontal = cards[0];
    const vertical = cards[1];
    if (!horizontal || !vertical) throw new Error("expected two cards");

    pointer(horizontal, "pointerdown", { pointerId: 1, clientX: 120, clientY: 20 });
    pointer(horizontal, "pointerup", { pointerId: 1, clientX: 55, clientY: 24 });
    const revealedRow = horizontal.closest("li");
    if (!revealedRow) throw new Error("expected revealed card row");
    expect(revealedRow.hasAttribute("data-revealed")).toBe(true);
    const swipeClear = within(revealedRow).getByRole("button", { name: /Clear scheduled message/ });
    expect(swipeClear.textContent).toBe("Clear");
    expect(swipeClear.classList.contains("snt-button--destructive")).toBe(true);
    expect(within(revealedRow).queryByRole("button", { name: /Clear notification/ })).toBeNull();
    fireEvent.click(horizontal);
    expect(sessionState.switchTo).not.toHaveBeenCalled();

    pointer(vertical, "pointerdown", { pointerId: 2, clientX: 120, clientY: 20 });
    pointer(vertical, "pointerup", { pointerId: 2, clientX: 110, clientY: 90 });
    fireEvent.click(vertical);
    await waitFor(() => expect(sessionState.switchTo).toHaveBeenCalledWith("session-2"));
  });

  it("clears from the keyboard and moves focus to the next surviving card", async () => {
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1), card(2)] }))
      .mockResolvedValueOnce(okPage({ cards: [card(2)] }));
    const sessionState = sessions();
    view({ api, sessionState });
    const firstRow = (await screen.findByText("Message 1")).closest("li");
    if (!firstRow) throw new Error("expected first card row");
    const clear = within(firstRow).getByRole("button", { name: /Clear notification/ });
    clear.focus();
    fireEvent.click(clear, { detail: 0 });

    await waitFor(() => expect(api.clearCard).toHaveBeenCalledWith("token", "session-1", expect.any(AbortSignal)));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Open scheduled message/ })));
    expect(sessionState.switchTo).not.toHaveBeenCalled();
    expect(screen.queryByText("Message 1")).toBeNull();
    expect(screen.getByText("Message 2")).toBeTruthy();
  });

  it("loads every retained page and moves focus from a final Load more to the appended card", async () => {
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1)], nextCursor: "page/2" }))
      .mockResolvedValueOnce(okPage({ cards: [card(2)] }));
    view({ api });

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    loadMore.focus();
    fireEvent.click(loadMore);
    await screen.findByText("Message 2");
    expect(api.cards).toHaveBeenLastCalledWith("token", "page/2", expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Message 2").closest("button")));
  });

  it("reloads page one after a clear, then pages without skips or duplicate concurrent arrivals", async () => {
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1), card(2)], nextCursor: "old-offset" }))
      .mockResolvedValueOnce(okPage({ cards: [card(0), card(2)], nextCursor: "new-offset" }))
      .mockResolvedValueOnce(okPage({ cards: [card(2), card(3)] }));
    view({ api });

    const firstRow = (await screen.findByText("Message 1")).closest("li");
    if (!firstRow) throw new Error("expected first card row");
    fireEvent.click(within(firstRow).getByRole("button", { name: /Clear notification/ }));
    await screen.findByText("Message 0");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("Message 3");

    expect(vi.mocked(api.cards).mock.calls.map((call) => call[1])).toEqual([undefined, undefined, "new-offset"]);
    expect(screen.queryByText("Message 1")).toBeNull();
    expect(screen.getAllByText("Message 2")).toHaveLength(1);
    expect(screen.getByText("Message 3")).toBeTruthy();
  });

  it("blocks row actions during recovery reload and restores focus inside the inbox", async () => {
    const recovery = Promise.withResolvers<Awaited<ReturnType<SchedulesApi["cards"]>>>();
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1), card(2)] }))
      .mockResolvedValueOnce(failed)
      .mockReturnValueOnce(recovery.promise);
    view({ api });

    const firstRow = (await screen.findByText("Message 1")).closest("li");
    if (!firstRow) throw new Error("expected first card row");
    fireEvent.click(within(firstRow).getByRole("button", { name: /Clear notification/ }));
    const reload = await screen.findByRole("button", { name: "Reload" });
    const survivingRow = screen.getByText("Message 2").closest("li");
    if (!survivingRow) throw new Error("expected surviving card row");
    const clear = within(survivingRow).getByRole("button", { name: /Clear notification/ });
    reload.focus();

    reload.click();
    clear.click();

    await waitFor(() => expect((screen.getByRole("button", { name: /Open scheduled message/ }) as HTMLButtonElement).disabled).toBe(true));
    expect(api.clearCard).toHaveBeenCalledOnce();
    recovery.resolve(okPage({ cards: [card(2)] }));
    await waitFor(() => expect(screen.queryByText("Clear succeeded")).toBeNull());
    expect(screen.getByText("Message 2")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Scheduled messages inbox" }).contains(document.activeElement)).toBe(true);
  });

  it("ignores an older replacement response after a newer acknowledged clear", async () => {
    const clear = Promise.withResolvers<Awaited<ReturnType<SchedulesApi["clearCard"]>>>();
    const olderReload = Promise.withResolvers<Awaited<ReturnType<SchedulesApi["cards"]>>>();
    const newerReload = Promise.withResolvers<Awaited<ReturnType<SchedulesApi["cards"]>>>();
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1), card(2), card(3)] }))
      .mockResolvedValueOnce(failed)
      .mockReturnValueOnce(olderReload.promise)
      .mockReturnValueOnce(newerReload.promise);
    vi.mocked(api.clearCard)
      .mockResolvedValueOnce({ ok: true, value: { cleared: true } })
      .mockReturnValueOnce(clear.promise);
    view({ api });

    const firstRow = (await screen.findByText("Message 1")).closest("li");
    if (!firstRow) throw new Error("expected first card row");
    fireEvent.click(within(firstRow).getByRole("button", { name: /Clear notification/ }));
    const reload = await screen.findByRole("button", { name: "Reload" });
    const secondRow = screen.getByText("Message 2").closest("li");
    if (!secondRow) throw new Error("expected second card row");

    within(secondRow).getByRole("button", { name: /Clear notification/ }).click();
    reload.click();
    clear.resolve({ ok: true, value: { cleared: true } });
    await waitFor(() => expect(api.cards).toHaveBeenCalledTimes(4));

    newerReload.resolve(okPage({ cards: [card(3)] }));
    await waitFor(() => expect(screen.queryByText("Message 2")).toBeNull());
    olderReload.resolve(okPage({ cards: [card(2), card(3)] }));
    await Promise.resolve();

    expect(screen.queryByText("Message 2")).toBeNull();
    expect(screen.getByText("Message 3")).toBeTruthy();
  });

  it("retries clear all with the original frozen occurrence ids", async () => {
    const api = apiFor([card(1), card(2)]);
    vi.mocked(api.clearCards).mockResolvedValueOnce(failed);
    view({ api });

    fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Clear all messages?" })).getByRole("button", { name: "Clear all" }));
    let dialog = await screen.findByRole("dialog", { name: "Clear outcome unknown" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry clear all…" }));
    dialog = screen.getByRole("dialog", { name: "Retry clear all?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry clear all" }));

    await waitFor(() => expect(api.clearCards).toHaveBeenCalledTimes(2));
    const targets = ["occurrence-1", "occurrence-2"];
    expect(vi.mocked(api.clearCards).mock.calls.map((call) => call[1])).toEqual([targets, targets]);
  });

  it("reconciles an unknown clear-all outcome without sending another DELETE", async () => {
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1)] }))
      .mockResolvedValueOnce(okPage({ cards: [] }));
    vi.mocked(api.clearCards).mockResolvedValueOnce(failed);
    view({ api });

    fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Clear all messages?" })).getByRole("button", { name: "Clear all" }));
    let dialog = await screen.findByRole("dialog", { name: "Clear outcome unknown" });
    expect(within(dialog).getByText("Request may have cleared messages. Reload to reconcile before retrying.")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Retry clear all…" }));
    dialog = screen.getByRole("dialog", { name: "Retry clear all?" });
    expect(within(dialog).getByText(/Retries target only the same confirmed messages/)).toBeTruthy();
    expect(api.clearCards).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));

    dialog = screen.getByRole("dialog", { name: "Clear outcome unknown" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("No scheduled messages yet")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Scheduled messages inbox" }).contains(document.activeElement)).toBe(true));
    expect(api.clearCards).toHaveBeenCalledOnce();
    expect(api.cards).toHaveBeenCalledTimes(2);
  });

  it("keeps failed clear-all reconciliation explicit and reloadable after closing", async () => {
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1)] }))
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(okPage({ cards: [] }));
    vi.mocked(api.clearCards).mockResolvedValueOnce(failed);
    view({ api });

    fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Clear all messages?" })).getByRole("button", { name: "Clear all" }));
    let dialog = await screen.findByRole("dialog", { name: "Clear outcome unknown" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload" }));

    expect(await within(dialog).findByText("Couldn’t reload messages. Clear outcome remains unknown. Try Reload again.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Reload" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.clearCards).toHaveBeenCalledOnce();
    const close = within(dialog).getAllByRole("button", { name: "Close" }).at(-1);
    if (!close) throw new Error("expected close action");
    fireEvent.click(close);

    expect(await screen.findByText("Couldn’t reload messages. Clear outcome remains unknown.")).toBeTruthy();
    const reload = screen.getByRole("button", { name: "Reload" });
    expect((reload as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /Open scheduled message/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reload);

    expect(await screen.findByText("No scheduled messages yet")).toBeTruthy();
    expect(screen.queryByText("Clear outcome unknown")).toBeNull();
    expect(api.clearCards).toHaveBeenCalledOnce();
    expect(api.cards).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["loaded", okPage({ cards: [card(1)] }), "Message 1"],
    ["error", failed, "Couldn’t load messages"],
  ] as const)("moves focus inside when a deferred initial load reaches %s state", async (_state, result, expectedText) => {
    const initial = Promise.withResolvers<Awaited<ReturnType<SchedulesApi["cards"]>>>();
    const api = apiFor();
    vi.mocked(api.cards).mockReturnValueOnce(initial.promise);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    view({ api });
    // AppShell keeps closed drawers mounted after the inbox in DOM order.
    render(<div aria-hidden="true"><div role="dialog" aria-label="Closed past chats" /></div>);
    await screen.findByText("Loading messages");
    outside.focus();

    initial.resolve(result);
    await screen.findByText(expectedText);
    const inbox = screen.getByRole("dialog", { name: "Scheduled messages inbox" });
    await waitFor(() => expect(inbox.contains(document.activeElement)).toBe(true));
    outside.remove();
  });

  it("repairs focus that arrives outside the open inbox", async () => {
    view({ api: apiFor([card(1)]) });
    await screen.findByText("Message 1");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear all" }));
    outside.remove();
  });

  it("keeps a successful clear visible when its authoritative reload fails", async () => {
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [card(1), card(2)], nextCursor: "old-offset" }))
      .mockResolvedValueOnce(failed);
    view({ api });

    const firstRow = (await screen.findByText("Message 1")).closest("li");
    if (!firstRow) throw new Error("expected first card row");
    fireEvent.click(within(firstRow).getByRole("button", { name: /Clear notification/ }));

    expect(await screen.findByText("Clear succeeded")).toBeTruthy();
    expect(screen.queryByText("Message 1")).toBeNull();
    expect(screen.getByText("Message 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("reloads authoritative cards whenever the inbox reopens", async () => {
    const api = apiFor();
    vi.mocked(api.cards)
      .mockResolvedValueOnce(okPage({ cards: [firstCard] }))
      .mockResolvedValueOnce(okPage({ cards: [] }));
    const rendered = view({ api });
    await screen.findByText(firstCard.preview ?? "");

    rendered.rerender(rendered.renderInbox("token", false));
    rendered.rerender(rendered.renderInbox("token", true));
    expect(await screen.findByText("No scheduled messages yet")).toBeTruthy();
    expect(api.cards).toHaveBeenCalledTimes(2);
  });

  it("aborts and ignores an in-flight clear after account identity changes", async () => {
    const oldClear = Promise.withResolvers<Awaited<ReturnType<SchedulesApi["clearCard"]>>>();
    let oldSignal: AbortSignal | undefined;
    const api = apiFor();
    vi.mocked(api.cards).mockImplementation((token) => Promise.resolve(okPage({ cards: [token === "old-token" ? card(1) : card(2)] })));
    vi.mocked(api.clearCard).mockImplementation((_token, _sessionId, signal) => {
      oldSignal = signal;
      return oldClear.promise;
    });
    const rendered = view({ api, token: "old-token" });
    fireEvent.click(await screen.findByRole("button", { name: /Clear notification/ }));
    await waitFor(() => expect(api.clearCard).toHaveBeenCalledOnce());

    rendered.rerender(rendered.renderInbox("new-token", true));
    await screen.findByText("Message 2");
    expect(oldSignal?.aborted).toBe(true);
    oldClear.resolve({ ok: true, value: { cleared: true } });
    await Promise.resolve();
    expect(screen.getByText("Message 2")).toBeTruthy();
    expect(screen.queryByText("Message 1")).toBeNull();
  });

  it("shows an empty state without inventing read state", async () => {
    view({ api: apiFor([]) });
    expect(await screen.findByText("No scheduled messages yet")).toBeTruthy();
    expect(document.querySelector("[aria-label*='unread']")).toBeNull();
  });
});
