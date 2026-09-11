import { render as renderPreact } from "preact";
import { act } from "preact/test-utils";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, it, vi } from "vitest";
import type { CalendarEvent } from "../../services/calendar-api.ts";
import { EventEditor, type CalendarEditorApiResult, type EventEditorProps } from "./event-editor.tsx";

const event: CalendarEvent = {
  eventId: "synthetic", revision: 1, scope: "private", title: "Original",
  start: { kind: "all-day", date: "2026-11-02" },
  visibility: "everyone", importance: "normal", tags: [],
};
const props: EventEditorProps = { event, inputTimeZoneId: "UTC", capabilities: { canUpdate: true } };
const title = () => screen.getByLabelText("Event title") as HTMLInputElement;
afterEach(cleanup);

it("retains input from the first interactive commit through passive effects and submission", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const onSubmit = vi.fn();
  try {
    // Deliberately do not use testing-library render: its act flushes passive
    // initialization before a user can interact, hiding the browser regression.
    renderPreact(<EventEditor {...props} onSubmit={onSubmit} />, host);
    title().value = "Immediate edit";
    title().dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {});
    expect(title().value).toBe("Immediate edit");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await act(async () => {});
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({ changes: expect.objectContaining({ title: "Immediate edit" }) }),
    }));
  } finally {
    renderPreact(null, host);
    host.remove();
  }
});

it("preserves a draft and its revision across refreshes, resets on target change and reopen", async () => {
  const onSubmit = vi.fn();
  const view = render(<EventEditor {...props} onSubmit={onSubmit} />);
  fireEvent.input(title(), { target: { value: "My draft" } });
  const refreshed = { ...event, revision: 2, title: "Refreshed" };
  view.rerender(<EventEditor {...props} event={refreshed} initialDraft={{ title: "New seed" }} onSubmit={onSubmit} />);
  expect(title().value).toBe("My draft");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => {});
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ expectedRevision: 1 }) }));
  view.rerender(<EventEditor {...props} event={{ ...event, eventId: "other", title: "Other" }} />);
  expect(title().value).toBe("Other");
  fireEvent.input(title(), { target: { value: "Discard on close" } });
  view.rerender(<EventEditor {...props} open={false} />);
  view.rerender(<EventEditor {...props} event={refreshed} />);
  expect(title().value).toBe("Refreshed");
});

it.each(["target", "reopen"])("ignores a late mutation result after %s", async (transition) => {
  let resolve!: (value: CalendarEditorApiResult) => void;
  const onSubmit = vi.fn(() => new Promise<CalendarEditorApiResult>((done) => { resolve = done; }));
  const onClose = vi.fn();
  const onOutcome = vi.fn();
  const current = { ...props, onSubmit, onClose, onOutcome };
  const view = render(<EventEditor {...current} />);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  if (transition === "reopen") view.rerender(<EventEditor {...current} open={false} />);
  view.rerender(<EventEditor {...current} event={{ ...event, eventId: transition === "target" ? "other" : "synthetic" }} />);
  fireEvent.input(title(), { target: { value: "New lifetime" } });
  await act(async () => { resolve({ ok: true, value: event }); });
  expect(title().value).toBe("New lifetime");
  expect(onClose).not.toHaveBeenCalled();
  expect(onOutcome).not.toHaveBeenCalled();
});

it("does not show a late conflict reread in a replacement editor", async () => {
  let resolve!: (value: { ok: true; value: CalendarEvent }) => void;
  const onReread = vi.fn(() => new Promise<{ ok: true; value: CalendarEvent }>((done) => { resolve = done; }));
  const onSubmit = vi.fn(async () => ({ ok: false as const, error: { status: 409, code: "conflict" } }));
  const view = render(<EventEditor {...props} onSubmit={onSubmit} onReread={onReread} />);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => {});
  await waitFor(() => expect(screen.getByRole("button", { name: "Review latest" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Review latest" }));
  expect(onReread).toHaveBeenCalledTimes(1);
  view.rerender(<EventEditor {...props} event={{ ...event, eventId: "other" }} />);
  await act(async () => { resolve({ ok: true, value: event }); });
  expect(screen.queryByText("Latest saved version")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
