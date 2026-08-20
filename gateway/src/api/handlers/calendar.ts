import type { AccessManager } from "../../access/access-manager.js";
import { openCalendarStore } from "../../calendar/calendar-store.js";
import {
  type CalendarConfig,
  type StoredCalendarEvent,
  type CalendarEventId,
  type CalendarListWindow,
  type CalendarStore,
  type CalendarTime,
  type Occurrence,
  type Importance,
  type WireCalendarEvent,
  type WireCalendarOccurrence,
  calendarCreateEventSchema,
  calendarEventSchema,
  wireCalendarTimeSchema,
} from "../../calendar/types.js";
import { type UserPrincipal, createUserPrincipal } from "../../identity/user-principal.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";

const ROOT = "/api/v1/calendar";
const EVENTS = `${ROOT}/events`;
const HOUSEHOLD_ID = "home";
const config: CalendarConfig = Object.freeze({
  query: Object.freeze({ maxDays: 366, maxOccurrences: 250, pageSize: 100 }),
  input: Object.freeze({
    maxTitleChars: 512,
    maxDescriptionChars: 8000,
    maxQueryChars: 512,
    maxGroupChars: 128,
    maxTagChars: 64,
    maxTags: 32,
  }),
  output: Object.freeze({ maxResultChars: 16000 }),
  recurrence: Object.freeze({ maxOccurrences: 1000, maxDays: 366 }),
  nudge: Object.freeze({ maxPerDay: 10 }),
  defaultEventTimeZoneId: "household",
});

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
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const token = readBearer(request);
  if (!token) return error(401, "missing-token", "Bearer authentication is required", requestId);
  let valid: TokenResult<TokenPayload>;
  try {
    valid = await deps.tokens.validate(token);
  } catch {
    return error(500, "io-error", "Authentication service is unavailable", requestId);
  }
  if (!valid.ok) return error(401, valid.error, "Invalid bearer token", requestId);
  let stored: Awaited<ReturnType<UserStore["get"]>>;
  try {
    stored = await deps.users.get(valid.value.userId);
  } catch {
    return error(500, "io-error", "User service is unavailable", requestId);
  }
  if (!stored.ok || stored.value === null) return error(401, "user-not-found", "Authenticated user was not found", requestId);

  let principal: UserPrincipal;
  try {
    principal = createUserPrincipal(valid.value.userId, stored.value.role, HOUSEHOLD_ID);
  } catch {
    return error(401, "invalid-user-record", "Authenticated user record is invalid", requestId);
  }

  const url = new URL(request.url);
  const match = new RegExp(`^${EVENTS}(?:/([^/]+))?$`).exec(url.pathname);
  if (!match) return error(404, "not-found", "Calendar route not found", requestId);
  const id = match[1] === undefined ? undefined : safeDecode(match[1]);
  if (match[1] !== undefined && id === null) return error(404, "not-found", "Calendar event not found", requestId);

  let body: unknown;
  if (request.method === "POST" || request.method === "PATCH") {
    try {
      body = await request.json();
    } catch {
      return error(422, "invalid", "Request body is not valid JSON", requestId);
    }
    body = stripIdentity(body);
  }
  const open = deps.openStore ?? ((cap, cfg) => openCalendarStore(cap, cfg));
  const cfg = deps.calendarConfig ?? config;
  let privateStore: CalendarStore | undefined;
  let householdStore: CalendarStore | undefined;
  try {
    privateStore = open(deps.accessManager.grant(principal, "calendar-private"), cfg);
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
    return error(405, "method-not-allowed", "Method is not supported for this route", requestId);
  } catch {
    return error(500, "io-error", "Calendar storage is unavailable", requestId);
  } finally {
    privateStore?.close();
    householdStore?.close();
  }
}

function listEvents(privateStore: CalendarStore, householdStore: CalendarStore, url: URL, requestId: string): Response {
  const scope = parseScope(url.searchParams.get("scope"));
  const from = parseTime(url.searchParams.get("from"));
  const to = parseTime(url.searchParams.get("to"));
  if (!from || !to || from.kind !== to.kind)
    return error(422, "invalid", "from and to are required and must have the same time kind", requestId);
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
  if (privateResult.error !== "not-found") return errorFor(privateResult.error, requestId);
  const householdResult = householdStore.get(id);
  if (householdResult.ok) return wireResponse(toWire(householdResult.value, "household"), requestId);
  if (householdResult.error !== "not-found") return errorFor(householdResult.error, requestId);
  return errorFor("not-found", requestId);
}

function createEvent(
  privateStore: CalendarStore,
  householdStore: CalendarStore,
  input: unknown,
  requestId: string,
): Response {
  const parsed = parseEvent(input, true);
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
  const stores: Array<[CalendarStore, Scope]> = requestedScope
    ? [[requestedScope === "household" ? householdStore : privateStore, requestedScope]]
    : [
        [privateStore, "private"],
        [householdStore, "household"],
      ];
  for (const [store, scope] of stores) {
    const current = store.get(id);
    if (!current.ok) {
      if (current.error !== "not-found") return errorFor(current.error, requestId);
      if (requestedScope !== undefined) return errorFor("not-found", requestId);
      continue;
    }
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
    if (!found.ok) {
      if (found.error !== "not-found") return errorFor(found.error, requestId);
      continue;
    }
    const result = store.delete(id);
    return result.ok ? Response.json({ version: 1, requestId, body: { ok: true } }) : errorFor(result.error, requestId);
  }
  return errorFor("not-found", requestId);
}

function parseEvent(value: unknown, serverAssignTimestamps = false): { event: StoredCalendarEvent; scope: Scope } | null {
  if (!value || typeof value !== "object") return null;
  const scope = parseScope((value as Record<string, unknown>).scope) ?? "private";
  const {
    scope: _scope,
    userId: _userId,
    householdId: _householdId,
    ...rawCandidate
  } = value as Record<string, unknown>;
  // Timestamps are response metadata, not client-owned create fields. Remove
  // them before validation so old clients that included placeholders remain
  // compatible while new clients can omit them entirely.
  const candidate = serverAssignTimestamps
    ? (() => {
        const { createdAt: _createdAt, updatedAt: _updatedAt, ...withoutTimestamps } = rawCandidate;
        return withoutTimestamps;
      })()
    : rawCandidate;
  const parsed = (serverAssignTimestamps ? calendarCreateEventSchema : calendarEventSchema).safeParse({ ...candidate, scope });
  if (!parsed.success) return null;
  const wire = parsed.data;
  const notificationPolicy = "notificationPolicy" in wire ? wire.notificationPolicy : undefined;
  const { scope: _wireScope, ...rest } = wire;
  const now = new Date().toISOString() as StoredCalendarEvent["createdAt"];
  const event = {
    ...rest,
    createdAt: serverAssignTimestamps
      ? now
      : (wire as unknown as { createdAt: StoredCalendarEvent["createdAt"] }).createdAt,
    updatedAt: serverAssignTimestamps
      ? now
      : (wire as unknown as { updatedAt: StoredCalendarEvent["updatedAt"] }).updatedAt,
    ...(notificationPolicy ? { notification: notificationPolicy } : {}),
    tags: new Set(wire.tags),
  } as unknown as StoredCalendarEvent;
  return { event, scope };
}

function toWire(event: StoredCalendarEvent, scope: Scope): WireCalendarEvent {
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
  const candidate = (() => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && (parsed.kind === "timed" || parsed.kind === "all-day")) return parsed;
    } catch {}
    if (/^\d{4}-\d\d-\d\d$/.test(value)) return { kind: "all-day", date: value };
    if (!Number.isNaN(Date.parse(value)))
      return {
        kind: "timed",
        instant: new Date(value).toISOString(),
        timeZoneId: "household",
      };
    return null;
  })();
  const parsed = wireCalendarTimeSchema.safeParse(candidate);
  return parsed.success ? parsed.data as unknown as CalendarTime : null;
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
function statusFor(code: string): number {
  if (["missing-token", "malformed", "expired", "signature-invalid", "wrong-purpose", "user-not-found", "invalid-user-record"].includes(code)) return 401;
  if (code === "not-found") return 404;
  if (code === "forbidden") return 403;
  if (code === "method-not-allowed") return 405;
  if (["already-exists", "conflict"].includes(code)) return 409;
  if (["invalid", "recurrence-limit"].includes(code)) return 422;
  return 500;
}
function error(status: number, code: string, message: string, requestId: string): Response {
  return Response.json({ version: 1, requestId, error: { code, message } }, { status });
}
function errorFor(code: string, requestId: string, message = "Calendar operation failed"): Response {
  return error(statusFor(code), code, message, requestId);
}
