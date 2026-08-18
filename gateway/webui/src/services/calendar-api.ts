import type { ApiHttpError } from "./_helpers";
import { bearerHeaders, handleFetch, jsonHeaders } from "./_helpers";

export type CalendarScope = "private" | "household";
export type CalendarTime = { kind: "timed"; instant: string; timeZoneId: string } | { kind: "all-day"; date: string };
export type CalendarEvent = {
  id: string;
  scope: CalendarScope;
  title: string;
  description?: string;
  start: CalendarTime;
  end?: CalendarTime;
  recurrence?: { rrule: string; rule: Record<string, unknown> };
  exdates?: readonly CalendarTime[];
  exceptions?: readonly Record<string, unknown>[];
  visibility: "everyone" | "adults";
  importance: "normal" | "important" | "pinned";
  group?: string;
  tags: readonly string[];
  notificationPolicy?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
export type CalendarOccurrence = CalendarEvent & {
  occurrenceId: string;
  baseEventId: string;
  occurrenceStart: CalendarTime;
  occurrenceEnd?: CalendarTime;
};

export interface CalendarListOptions {
  from: CalendarTime;
  to: CalendarTime;
  scope?: CalendarScope;
  group?: string;
  tags?: readonly string[];
  importance?: CalendarEvent["importance"];
}
export interface CalendarList {
  events: CalendarOccurrence[];
  more: number;
}
export type CalendarPatch = Partial<Omit<CalendarEvent, "id" | "createdAt" | "updatedAt">>;
export type CalendarApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiHttpError };

interface Envelope<T> {
  version: 1;
  requestId: string;
  body: T;
}
export interface CalendarApi {
  list(token: string, options: CalendarListOptions): Promise<CalendarApiResult<CalendarList>>;
  get(token: string, id: string): Promise<CalendarApiResult<CalendarEvent>>;
  create(token: string, event: CalendarEvent): Promise<CalendarApiResult<CalendarEvent>>;
  update(token: string, id: string, patch: CalendarPatch): Promise<CalendarApiResult<CalendarEvent>>;
  delete(token: string, id: string): Promise<CalendarApiResult<{ ok: true }>>;
}

function unwrap<T>(result: CalendarApiResult<Envelope<T>>): CalendarApiResult<T> {
  return result.ok ? { ok: true, value: result.value.body } : result;
}
function queryTime(value: CalendarTime): string {
  return JSON.stringify(value);
}

export function createCalendarApi(config: { baseUrl?: string } = {}): CalendarApi {
  const base = config.baseUrl ?? "";
  return {
    async list(token, options) {
      const params = new URLSearchParams({ from: queryTime(options.from), to: queryTime(options.to) });
      if (options.scope) params.set("scope", options.scope);
      if (options.group) params.set("group", options.group);
      if (options.tags?.length) params.set("tags", options.tags.join(","));
      if (options.importance) params.set("importance", options.importance);
      return unwrap(
        await handleFetch<Envelope<CalendarList>>(
          fetch(`${base}/api/v1/calendar/events?${params}`, {
            method: "GET",
            headers: bearerHeaders(token),
          }),
        ),
      );
    },
    async get(token, id) {
      return unwrap(
        await handleFetch<Envelope<CalendarEvent>>(
          fetch(`${base}/api/v1/calendar/events/${encodeURIComponent(id)}`, {
            method: "GET",
            headers: bearerHeaders(token),
          }),
        ),
      );
    },
    async create(token, event) {
      return unwrap(
        await handleFetch<Envelope<CalendarEvent>>(
          fetch(`${base}/api/v1/calendar/events`, {
            method: "POST",
            headers: jsonHeaders(bearerHeaders(token)),
            body: JSON.stringify(event),
          }),
        ),
      );
    },
    async update(token, id, patch) {
      return unwrap(
        await handleFetch<Envelope<CalendarEvent>>(
          fetch(`${base}/api/v1/calendar/events/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: jsonHeaders(bearerHeaders(token)),
            body: JSON.stringify(patch),
          }),
        ),
      );
    },
    async delete(token, id) {
      return unwrap(
        await handleFetch<Envelope<{ ok: true }>>(
          fetch(`${base}/api/v1/calendar/events/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: bearerHeaders(token),
          }),
        ),
      );
    },
  };
}
