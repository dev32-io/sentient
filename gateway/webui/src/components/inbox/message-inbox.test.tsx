import { signal } from "@preact/signals";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { goldenScheduleWireFixtures } from "@sentient/protocol";
import { SessionsProvider } from "../../context/sessions.tsx";
import type { UseSessions } from "../../hooks/use-sessions.ts";
import type { SchedulesApi } from "../../services/schedules-api.ts";
import { MessageInbox } from "./message-inbox.tsx";

function sessions(ok = true): UseSessions {
  return { items: signal([]), searchHits: signal(null), loading: signal(false), error: signal(null), currentId: signal(null), load: vi.fn(), search: vi.fn(), switchTo: vi.fn().mockResolvedValue(ok), newChat: vi.fn(), delete: vi.fn(), rename: vi.fn(), dispose: vi.fn() };
}
function api(cards: typeof goldenScheduleWireFixtures.cards.cards): SchedulesApi {
  return { cards: vi.fn().mockResolvedValue({ ok: true, value: { cards } }), list: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as SchedulesApi;
}

describe("scheduled message inbox", () => {
  it("renders bounded cards and resumes their existing session", async () => {
    const sessionState = sessions(); const opened = vi.fn();
    render(<SessionsProvider value={sessionState}><MessageInbox open token="token" api={api(goldenScheduleWireFixtures.cards.cards)} onClose={vi.fn()} onOpenedSession={opened} /></SessionsProvider>);
    const [card] = await screen.findAllByRole("button", { name: /Open scheduled message/ });
    if (!card) throw new Error("expected a scheduled message card");
    expect(card.textContent).toContain("garden plan");
    expect(card.querySelector("strong")?.textContent?.length).toBeLessThanOrEqual(280);
    fireEvent.click(card);
    await waitFor(() => expect(sessionState.switchTo).toHaveBeenCalledWith("ses_scheduled_1"));
    expect(opened).toHaveBeenCalledOnce();
  });

  it("shows an empty state without inventing read state", async () => {
    render(<SessionsProvider value={sessions()}><MessageInbox open token="token" api={api([])} onClose={vi.fn()} onOpenedSession={vi.fn()} /></SessionsProvider>);
    expect(await screen.findByText("No scheduled messages yet")).toBeTruthy();
    expect(document.querySelector("[aria-label*='unread']")).toBeNull();
  });
});
