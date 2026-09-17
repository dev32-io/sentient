import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../services/calendar-api.ts";
import { buildCreateInput, buildUpdateCommand, initialDraftFor } from "./calendar-editor-model.ts";

const event: CalendarEvent = {
  eventId: "event-1",
  revision: 2,
  scope: "private",
  title: "Dentist",
  start: { kind: "timed", instant: "2026-08-05T13:00:00.000Z" },
  visibility: "everyone",
  importance: "normal",
  tags: [],
  reminder: { reminderId: "rem-1", enabled: true, mode: "lead", leadMinutes: 30 },
};

describe("calendar personal reminder projection", () => {
  it("defaults create reminders off and includes an enabled all-day time only when chosen", () => {
    const draft = initialDraftFor(null, "create", "America/Toronto", {
      title: "Picnic",
      allDay: true,
      start: "2026-08-09",
      end: "",
      reminderEnabled: true,
      reminderLocalTime: "09:00",
    });
    expect(buildCreateInput(draft)).toMatchObject({
      ok: true,
      value: { reminder: { enabled: true, mode: "all-day", localTime: "09:00", timeZone: "America/Toronto" } },
    });
    expect(buildCreateInput({ ...draft, reminderEnabled: false })).not.toHaveProperty("value.reminder");
  });

  it("preserves an unchanged actor reminder by omission and emits only an intentional disable", () => {
    const draft = initialDraftFor(event, "edit", "UTC");
    const unchanged = buildUpdateCommand(event, { ...draft, title: "Dentist appointment" }, "entire_series");
    expect(unchanged.ok && unchanged.command.changes).not.toHaveProperty("reminder");
    const disabled = buildUpdateCommand(event, { ...draft, reminderEnabled: false }, "entire_series");
    expect(disabled.ok && disabled.command.changes).toMatchObject({ reminder: { enabled: false } });
  });
});
