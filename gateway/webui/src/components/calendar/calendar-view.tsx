import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { useAuth } from "../../hooks/use-auth.tsx";
import { createCalendarApi, type CalendarApi, type CalendarEvent, type CalendarOccurrence, type CalendarTime } from "../../services/calendar-api.ts";
import "./calendar-view.css";

type CalendarDraft = {
  title: string;
  start: string;
  allDay: boolean;
  /** Zone in which the datetime-local input is displayed and parsed. */
  inputTimeZoneId: string;
  /** The event's persisted zone; new events use the browser's IANA zone. */
  eventTimeZoneId?: string;
};

export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    // Fall through to the portable IANA fallback.
  }
  return "UTC";
}

function zonedParts(instant: number, timeZoneId: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

/** Format an instant for a datetime-local input without treating UTC fields as local fields. */
export function formatCalendarInputValue(instant: string, timeZoneId = browserTimeZone()): string {
  const p = zonedParts(Date.parse(instant), timeZoneId);
  return `${String(p.year ?? 0).padStart(4, "0")}-${String(p.month ?? 1).padStart(2, "0")}-${String(p.day ?? 1).padStart(2, "0")}T${String(p.hour ?? 0).padStart(2, "0")}:${String(p.minute ?? 0).padStart(2, "0")}`;
}

/** Parse a local datetime in an explicit IANA zone to its UTC instant. */
export function parseCalendarInput(value: string, timeZoneId = browserTimeZone()): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = new Set<number>();
  for (let offsetDays = -2; offsetDays <= 2; offsetDays++) {
    const probe = naive + offsetDays * 86_400_000;
    const p = zonedParts(probe, timeZoneId);
    const offset = probe - Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0);
    const candidate = naive + offset;
    const checked = zonedParts(candidate, timeZoneId);
    if (checked.year === year && checked.month === month && checked.day === day && checked.hour === hour && checked.minute === minute) {
      candidates.add(candidate);
    }
  }
  const instant = candidates.size ? Math.min(...candidates) : NaN;
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

export function formatCalendarTime(value: CalendarTime): string {
  if (value.kind === "all-day") {
    const parts = value.date.split("-").map(Number);
    const year = parts[0] ?? 0;
    const month = parts[1] ?? 1;
    const day = parts[2] ?? 1;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(year, month - 1, day));
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value.instant));
}

function weekWindow(): { from: CalendarTime; to: CalendarTime } {
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  const timeZoneId = browserTimeZone();
  return { from: { kind: "timed", instant: from.toISOString(), timeZoneId }, to: { kind: "timed", instant: to.toISOString(), timeZoneId } };
}
function emptyDraft(): CalendarDraft {
  const timeZoneId = browserTimeZone();
  const start = new Date(Date.now() + 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  return { title: "", start: formatCalendarInputValue(start.toISOString(), timeZoneId), allDay: false, inputTimeZoneId: timeZoneId, eventTimeZoneId: timeZoneId };
}
function draftTime(draft: CalendarDraft): CalendarTime {
  if (draft.allDay) return { kind: "all-day", date: draft.start.slice(0, 10) };
  const instant = parseCalendarInput(draft.start, draft.inputTimeZoneId);
  return {
    kind: "timed",
    instant: instant ?? new Date().toISOString(),
    timeZoneId: draft.eventTimeZoneId ?? browserTimeZone(),
  };
}

export interface CalendarViewProps { api?: CalendarApi; token?: string }

export function CalendarView({ api, token: suppliedToken }: CalendarViewProps = {}): JSX.Element {
  const stableApi = useMemo(() => api ?? createCalendarApi(), [api]);
  const auth = useAuth();
  const token = suppliedToken ?? (auth.status === "authenticated" ? auth.token : "");
  const [events, setEvents] = useState<CalendarOccurrence[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const window = useMemo(weekWindow, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    // The REST contract requires the window endpoints to use one time kind;
    // fetch both timed and all-day windows so an all-day event is not lost.
    const allDayFrom = new Date(window.from.kind === "timed" ? window.from.instant : Date.now());
    const allDayTo = new Date(window.to.kind === "timed" ? window.to.instant : Date.now());
    const date = (value: Date) => value.toISOString().slice(0, 10);
    const [timedResult, allDayResult] = await Promise.all([
      stableApi.list(token, window),
      stableApi.list(token, { from: { kind: "all-day", date: date(allDayFrom) }, to: { kind: "all-day", date: date(allDayTo) } }),
    ]);
    if (timedResult.ok && allDayResult.ok) {
      const merged = [...timedResult.value.events, ...allDayResult.value.events];
      // An expanded recurring instance is a separate row. Only the occurrence
      // identity is stable for this list; baseEventId is shared by design.
      setEvents([...new Map(merged.map((event) => [event.occurrenceId, event])).values()]); setError(null);
    } else setError("Couldn't load calendar events.");
  }, [stableApi, token, window]);
  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!draft.title.trim() || busy) return;
    setBusy(true); setError(null);
    const start = draftTime(draft);
    const result = editing
      ? await stableApi.update(token, editing, { title: draft.title.trim(), start })
      : await stableApi.create(token, {
          id: crypto.randomUUID(), title: draft.title.trim(), start, scope: "private", visibility: "everyone",
          importance: "normal", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
    setBusy(false);
    if (!result.ok) { setError("Couldn't save calendar event."); return; }
    setDraft(emptyDraft()); setEditing(null); await refresh();
  };
  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true); const result = await stableApi.delete(token, id); setBusy(false);
    if (!result.ok) { setError("Couldn't delete calendar event."); return; }
    if (editing === id) { setEditing(null); setDraft(emptyDraft()); }
    await refresh();
  };
  const beginEdit = (event: CalendarEvent) => {
    setEditing((event as CalendarOccurrence).baseEventId ?? event.id);
    if (event.start.kind === "all-day") {
      setDraft({ title: event.title, allDay: true, start: event.start.date, inputTimeZoneId: browserTimeZone() });
      return;
    }
    const inputTimeZoneId = browserTimeZone();
    setDraft({
      title: event.title,
      allDay: false,
      start: formatCalendarInputValue(event.start.instant, inputTimeZoneId),
      inputTimeZoneId,
      eventTimeZoneId: event.start.timeZoneId,
    });
  };

  return (
    <section class="calendar-view" aria-labelledby="calendar-title">
      <div class="calendar-view__head"><div><h1 id="calendar-title">Calendar</h1><p>Events for this week</p></div><button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
      <form class="calendar-form" onSubmit={submit}>
        <label>Title<input aria-label="Event title" value={draft.title} onInput={(e) => setDraft({ ...draft, title: (e.currentTarget as HTMLInputElement).value })} required /></label>
        <label>{draft.allDay ? "Date" : "Start"}<input aria-label={draft.allDay ? "Event date" : "Event start"} type={draft.allDay ? "date" : "datetime-local"} value={draft.allDay ? draft.start.slice(0, 10) : draft.start} onInput={(e) => setDraft({ ...draft, start: (e.currentTarget as HTMLInputElement).value })} required /></label>
        <label class="calendar-form__check"><input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft({ ...draft, allDay: (e.currentTarget as HTMLInputElement).checked })} /> All day</label>
        <button type="submit" disabled={busy}>{editing ? "Update event" : "Add event"}</button>
        {editing && <button type="button" onClick={() => { setEditing(null); setDraft(emptyDraft()); }}>Cancel</button>}
      </form>
      {error && <p role="alert" class="calendar-error">{error}</p>}
      <div class="calendar-days">
        {events.length === 0 ? <p class="calendar-empty">No events this week.</p> : events.map((event) => (
          <article class="calendar-event" key={event.occurrenceId}>
            <div><strong>{event.title}</strong><time dateTime={event.start.kind === "timed" ? event.start.instant : event.start.date}>{formatCalendarTime(event.start)}</time>{event.end && <time>– {formatCalendarTime(event.end)}</time>}</div>
            <div><button type="button" onClick={() => beginEdit(event)} disabled={busy}>Edit</button><button type="button" onClick={() => void remove(event.baseEventId)} disabled={busy}>Delete</button></div>
          </article>
        ))}
      </div>
    </section>
  );
}
