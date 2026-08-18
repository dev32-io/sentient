import type { AccessManager } from "../../access/access-manager.js";
import { openCalendarStore } from "../../calendar/calendar-store.js";
import {
  type CalendarConfig,
  type CalendarEvent,
  type CalendarEventId,
  type CalendarListWindow,
  type CalendarStore,
  type CalendarTime,
  type EventTimeZoneId,
  type Occurrence,
  type Importance,
  type WireCalendarEvent,
  type WireCalendarOccurrence,
  calendarEventSchema,
} from "../../calendar/types.js";
import { type UserPrincipal, createUserPrincipal } from "../../identity/user-principal.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";

const ROOT = "/api/v1/calendar";
const EVENTS = `${ROOT}/events`;
const HOUSEHOLD_ID = "home";
const config = { recurrence: { maxOccurrences: 1000, maxDays: 366 }, nudge: { maxPerDay: 10 } } as CalendarConfig;

type Scope = "private" | "household";
export interface CalendarHandlerDeps {
  tokens: { validate: (token: string) => Promise<TokenResult<TokenPayload>> };
  users: Pick<UserStore, "get">;
  accessManager: AccessManager;
  calendarConfig?: CalendarConfig;
  /** Injectable to keep request lifetime and close behaviour testable. */
  openStore?: (cap: ReturnType<AccessManager["grant"]>, cfg: CalendarConfig) => CalendarStore;
}

export function createCalendarHandler(deps: CalendarHandlerDeps): (request: Request) => Promise<Response> {
  return (request) => handleCalendar(deps, request);
}

async function handleCalendar(deps: CalendarHandlerDeps, request: Request): Promise<Response> {
  const token = readBearer(request);
  if (!token) return error(401, "missing-token", "Bearer authentication is required");
  const valid = await deps.tokens.validate(token);
  if (!valid.ok) return error(401, valid.error, "Invalid bearer token");
  const stored = await deps.users.get(valid.value.userId);
  if (!stored.ok || stored.value === null) return error(401, "user-not-found", "Authenticated user was not found");

  let principal: UserPrincipal;
  try {
    principal = createUserPrincipal(valid.value.userId, stored.value.role, HOUSEHOLD_ID);
  } catch {
    return error(401, "invalid-user-record", "Authenticated user record is invalid");
  }

  const url = new URL(request.url);
  const match = new RegExp(`^${EVENTS}(?:/([^/]+))?$`).exec(url.pathname);
  if (!match) return error(404, "not-found", "Calendar route not found");
  const id = match[1] === undefined ? undefined : safeDecode(match[1]);
  if (match[1] !== undefined && id === null) return error(404, "not-found", "Calendar event not found");

  let body: unknown;
  if (request.method === "POST" || request.method === "PATCH") {
    try {
      body = await request.json();
    } catch {
      return error(422, "invalid", "Request body is not valid JSON");
    }
    body = stripIdentity(body);
  }
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const open = deps.openStore ?? ((cap, cfg) => openCalendarStore(cap, cfg));
  const cfg = deps.calendarConfig ?? config;
  const privateStore = open(deps.accessManager.grant(principal, "calendar-private"), cfg);
  let householdStore: CalendarStore | undefined;
  try {
    householdStore = open(deps.accessManager.grant(principal, "calendar-household"), cfg);
    if (request.method === "GET" && id === undefined) return listEvents(privateStore, householdStore, url, requestId);
    if (request.method === "GET" && id !== undefined)
      return getEvent(privateStore, householdStore, id as CalendarEventId, requestId);
    if (request.method === "POST" && id === undefined)
      return createEvent(privateStore, householdStore, body, requestId);
    if (request.method === "PATCH" && id !== undefined)
      return updateEvent(privateStore, householdStore, id as CalendarEventId, body, requestId);
    if (request.method === "DELETE" && id !== undefined)
      return deleteEvent(privateStore, householdStore, id as CalendarEventId, requestId);
    return error(405, "method-not-allowed", "Method is not supported for this route");
  } finally {
    privateStore.close();
    householdStore?.close();
  }
}

function listEvents(privateStore: CalendarStore, householdStore: CalendarStore, url: URL, requestId: string): Response {
  const scope = parseScope(url.searchParams.get("scope"));
  const from = parseTime(url.searchParams.get("from"));
  const to = parseTime(url.searchParams.get("to"));
  if (!from || !to || from.kind !== to.kind)
    return error(422, "invalid", "from and to are required and must have the same time kind");
  const group = url.searchParams.get("group");
  const tags = (url.searchParams.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const importance = url.searchParams.get("importance");
  const window: CalendarListWindow = {
    from,
    to,
    ...(group ? { group } : {}),
    ...(tags.length ? { tags } : {}),
    ...(importance && ["normal", "important", "pinned"].includes(importance)
      ? { importance: importance as Importance }
      : {}),
  };
  const stores: Array<[CalendarStore, Scope]> =
    scope === "private"
      ? [[privateStore, "private"]]
      : scope === "household"
        ? [[householdStore, "household"]]
        : [
            [privateStore, "private"],
            [householdStore, "household"],
          ];
  const events: WireCalendarOccurrence[] = [];
  for (const [store, storeScope] of stores) {
    const result = store.list(window);
    if (!result.ok) return errorFor(result.error, requestId);
    events.push(...result.value.map((occurrence) => toWireOccurrence(occurrence, storeScope)));
  }
  return Response.json({ version: 1, requestId, body: { events, more: 0 } });
}

function getEvent(
  privateStore: CalendarStore,
  householdStore: CalendarStore,
  id: CalendarEventId,
  requestId: string,
): Response {
  const privateResult = privateStore.get(id);
  if (privateResult.ok) return wireResponse(toWire(privateResult.value, "private"), requestId);
  const householdResult = householdStore.get(id);
  if (householdResult.ok) return wireResponse(toWire(householdResult.value, "household"), requestId);
  return errorFor("not-found", requestId);
}

function createEvent(
  privateStore: CalendarStore,
  householdStore: CalendarStore,
  input: unknown,
  requestId: string,
): Response {
  const parsed = parseEvent(input);
  if (!parsed) return errorFor("invalid", requestId);
  const scope = parsed.scope;
  const result = (scope === "household" ? householdStore : privateStore).create(parsed.event);
  return result.ok ? wireResponse(toWire(result.value, scope), requestId) : errorFor(result.error, requestId);
}

function updateEvent(
  privateStore: CalendarStore,
  householdStore: CalendarStore,
  id: CalendarEventId,
  input: unknown,
  requestId: string,
): Response {
  const requestedScope =
    input && typeof input === "object" ? parseScope((input as Record<string, unknown>).scope) : undefined;
  const stores: Array<[CalendarStore, Scope]> =
    requestedScope === "household"
      ? [
          [householdStore, "household"],
          [privateStore, "private"],
        ]
      : [
          [privateStore, "private"],
          [householdStore, "household"],
        ];
  for (const [store, scope] of stores) {
    const current = store.get(id);
    if (!current.ok) continue;
    const supplied = parseEvent({
      ...toWire(current.value, scope),
      ...(input && typeof input === "object" ? input : {}),
      scope,
    });
    if (!supplied) return errorFor("invalid", requestId);
    const { id: _eventId, createdAt: _createdAt, ...patch } = supplied.event;
    const result = store.update(id, patch);
    return result.ok ? wireResponse(toWire(result.value, scope), requestId) : errorFor(result.error, requestId);
  }
  return errorFor("not-found", requestId);
}

function deleteEvent(
  privateStore: CalendarStore,
  householdStore: CalendarStore,
  id: CalendarEventId,
  requestId: string,
): Response {
  for (const store of [privateStore, householdStore]) {
    const found = store.get(id);
    if (!found.ok) continue;
    const result = store.delete(id);
    return result.ok ? Response.json({ version: 1, requestId, body: { ok: true } }) : errorFor(result.error, requestId);
  }
  return errorFor("not-found", requestId);
}

function parseEvent(value: unknown): { event: CalendarEvent; scope: Scope } | null {
  if (!value || typeof value !== "object") return null;
  const scope = parseScope((value as Record<string, unknown>).scope) ?? "private";
  const { scope: _scope, userId: _userId, householdId: _householdId, ...candidate } = value as Record<string, unknown>;
  const parsed = calendarEventSchema.safeParse({ ...candidate, scope });
  if (!parsed.success) return null;
  const wire = parsed.data;
  const { scope: _wireScope, notificationPolicy, ...rest } = wire;
  const event = {
    ...rest,
    ...(notificationPolicy ? { notification: notificationPolicy } : {}),
    tags: new Set(wire.tags),
  } as unknown as CalendarEvent;
  return { event, scope };
}

function toWire(event: CalendarEvent, scope: Scope): WireCalendarEvent {
  return {
    id: event.id,
    scope,
    title: event.title,
    ...(event.description !== undefined ? { description: event.description } : {}),
    start: event.start,
    ...(event.end !== undefined ? { end: event.end } : {}),
    ...(event.recurrence !== undefined ? { recurrence: event.recurrence } : {}),
    ...(event.exdates !== undefined ? { exdates: event.exdates } : {}),
    ...(event.exceptions !== undefined ? { exceptions: event.exceptions } : {}),
    visibility: event.visibility,
    importance: event.importance,
    ...(event.group !== undefined ? { group: event.group } : {}),
    tags: [...event.tags],
    ...(event.notification !== undefined ? { notificationPolicy: event.notification } : {}),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}
function toWireOccurrence(occurrence: Occurrence, scope: Scope): WireCalendarOccurrence {
  return {
    ...toWire(occurrence, scope),
    id: occurrence.occurrenceId as CalendarEventId,
    baseEventId: occurrence.baseEventId,
    start: occurrence.start,
    ...(occurrence.end !== undefined ? { end: occurrence.end } : {}),
    occurrenceId: occurrence.occurrenceId,
    occurrenceStart: occurrence.occurrenceStart,
    ...(occurrence.occurrenceEnd !== undefined ? { occurrenceEnd: occurrence.occurrenceEnd } : {}),
  };
}
function wireResponse(event: WireCalendarEvent, requestId: string): Response {
  return Response.json({ version: 1, requestId, body: event });
}
function stripIdentity(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { userId: _userId, householdId: _householdId, ...copy } = value as Record<string, unknown>;
  return copy;
}
function parseScope(value: string | unknown): Scope | undefined {
  return value === "private" || value === "household" ? value : undefined;
}
function parseTime(value: string | null): CalendarTime | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && (parsed.kind === "timed" || parsed.kind === "all-day")) return parsed as CalendarTime;
  } catch {}
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return { kind: "all-day", date: value as `${number}-${number}-${number}` };
  if (!Number.isNaN(Date.parse(value)))
    return {
      kind: "timed",
      instant: new Date(value).toISOString() as import("../../calendar/types.js").UtcInstant,
      timeZoneId: "household" as EventTimeZoneId,
    };
  return null;
}
function readBearer(request: Request): string | null {
  const parts = (request.headers.get("authorization") ?? "").split(" ");
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer" && parts[1] ? parts[1] : null;
}
function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
function error(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}
function errorFor(code: string, requestId?: string): Response {
  const status =
    code === "not-found"
      ? 404
      : code === "forbidden"
        ? 403
        : code === "already-exists"
          ? 409
          : code === "invalid"
            ? 422
            : 500;
  return Response.json(requestId ? { version: 1, requestId, error: { code, message: code } } : { error: code }, {
    status,
  });
}
