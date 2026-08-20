import type { AccessManager } from "../../access/access-manager.js";
import { createCalendarEvent, mutateCalendarEvent } from "../../calendar/calendar-mutations.js";
import { createCalendarQueryService } from "../../calendar/calendar-query.js";
import { type CalendarPersistence, openCalendarPersistence } from "../../calendar/calendar-store.js";
import { normalizeCalendarQuery } from "../../calendar/calendar-temporal.js";
import {
  type CalendarConfig,
  type CalendarCreateInput,
  type CalendarError,
  type CalendarEventId,
  type CalendarMutationCommand,
  type CalendarTimeInput,
  calendarCreateEventSchema,
  calendarMutationCommandSchema,
} from "../../calendar/types.js";
import { type UserPrincipal, createUserPrincipal } from "../../identity/user-principal.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";

const EVENTS = "/api/v1/calendar/events";
const HOUSEHOLD_ID = "home";
const defaultConfig: CalendarConfig = Object.freeze({
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

export interface CalendarHandlerDeps {
  tokens: { validate: (token: string) => Promise<TokenResult<TokenPayload>> };
  users: Pick<UserStore, "get">;
  accessManager: AccessManager;
  calendarConfig?: CalendarConfig;
  /** Concrete household zone resolved by the composition root. */
  householdTimeZone?: string;
  /** Injectable request-scoped V2 persistence opener used by handler tests. */
  openStore?: (cap: ReturnType<AccessManager["grant"]>, cfg: CalendarConfig) => CalendarPersistence;
}

export function createCalendarHandler(deps: CalendarHandlerDeps): (request: Request) => Promise<Response> {
  return (request) => handleCalendar(deps, request);
}

type Route =
  | { kind: "list" }
  | { kind: "get"; eventId: CalendarEventId }
  | { kind: "mutate"; eventId: CalendarEventId };

async function handleCalendar(deps: CalendarHandlerDeps, request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const token = readBearer(request);
  if (!token) return error(401, "missing_token", "Bearer authentication is required", requestId);

  let valid: TokenResult<TokenPayload>;
  try {
    valid = await deps.tokens.validate(token);
  } catch {
    return error(503, "io_error", "Authentication service is unavailable", requestId);
  }
  if (!valid.ok) return error(401, tokenErrorCode(valid.error), "Invalid bearer token", requestId);

  let stored: Awaited<ReturnType<UserStore["get"]>>;
  try {
    stored = await deps.users.get(valid.value.userId);
  } catch {
    return error(503, "io_error", "User service is unavailable", requestId);
  }
  if (!stored.ok || stored.value === null)
    return error(401, "user_not_found", "Authenticated user was not found", requestId);

  let principal: UserPrincipal;
  try {
    principal = createUserPrincipal(valid.value.userId, stored.value.role, HOUSEHOLD_ID);
  } catch {
    return error(401, "invalid_user_record", "Authenticated user record is invalid", requestId);
  }

  const route = matchRoute(new URL(request.url).pathname);
  if (!route) return error(404, "not_found", "Calendar route not found", requestId);
  if (!methodAllowed(request.method, route.kind)) {
    return error(405, "invalid_range", "Method is not supported for this calendar route", requestId);
  }

  const url = new URL(request.url);
  let body: unknown;
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      return error(422, "malformed", "Request body is not valid JSON", requestId);
    }
  }

  const cfg = deps.calendarConfig ?? defaultConfig;
  if (route.kind === "list" && request.method === "GET") {
    const preflight = preflightList(listInput(url), cfg, requestId);
    if (preflight) return preflight;
  }
  const open = deps.openStore ?? ((cap, config) => openCalendarPersistence(cap, config));
  let privateStore: CalendarPersistence | undefined;
  let householdStore: CalendarPersistence | undefined;
  try {
    // Both handles are capability-bound to this immutable principal. The
    // query/mutation services select a scope explicitly; opening both does
    // not grant the handler ambient authority or cause an omitted-scope read
    // to search the household store.
    privateStore = open(deps.accessManager.grant(principal, "calendar-private"), cfg);
    householdStore = open(deps.accessManager.grant(principal, "calendar-household"), cfg);
    const query = createCalendarQueryService({
      private: privateStore,
      household: householdStore,
      role: principal.role,
      config: cfg,
      ...(deps.householdTimeZone ? { householdTimeZone: deps.householdTimeZone } : {}),
    });

    if (route.kind === "list") {
      if (request.method === "POST") return createEvent(privateStore, householdStore, body, cfg, requestId);
      return listEvents(query, url, requestId);
    }
    if (route.kind === "get") return getEvent(query, route.eventId, url, requestId);
    if (route.kind === "mutate") return mutateEvent(privateStore, householdStore, route.eventId, body, cfg, requestId);
    return error(404, "not_found", "Calendar route not found", requestId);
  } catch {
    // Domain services return typed failures. This catch is only the adapter
    // seam for an opener/service/serialization failure that escaped it.
    return error(503, "io_error", "Calendar storage is unavailable", requestId);
  } finally {
    closeStore(privateStore);
    closeStore(householdStore);
  }
}

function listEvents(query: ReturnType<typeof createCalendarQueryService>, url: URL, requestId: string): Response {
  const result = query.list(listInput(url));
  return result.ok ? response(result.value, requestId) : errorFor(result.error, requestId);
}

function listInput(url: URL): Record<string, unknown> {
  const input: Record<string, unknown> = {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    ...(url.searchParams.get("scope") !== null ? { scope: url.searchParams.get("scope") } : {}),
    ...(url.searchParams.get("query") !== null ? { query: url.searchParams.get("query") } : {}),
    ...(url.searchParams.get("group") !== null ? { group: url.searchParams.get("group") } : {}),
    ...(url.searchParams.get("importance") !== null ? { importance: url.searchParams.get("importance") } : {}),
    ...(url.searchParams.get("cursor") !== null ? { cursor: url.searchParams.get("cursor") } : {}),
  };
  const tags = url.searchParams.get("tags");
  if (tags !== null)
    input.tags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  return input;
}

function preflightList(input: Record<string, unknown>, cfg: CalendarConfig, requestId: string): Response | undefined {
  if (input.scope !== undefined && input.scope !== "private" && input.scope !== "household" && input.scope !== "all") {
    return error(422, "invalid_scope", "scope must be private, household, or all", requestId);
  }
  const result = normalizeCalendarQuery(input, cfg);
  return result.ok ? undefined : errorFor(result.error, requestId);
}

function getEvent(
  query: ReturnType<typeof createCalendarQueryService>,
  eventId: CalendarEventId,
  url: URL,
  requestId: string,
): Response {
  const scope = url.searchParams.get("scope");
  const originalStart = url.searchParams.get("originalStart");
  const result = query.get({
    eventId,
    ...(scope !== null ? { scope: scope as "private" | "household" | "all" } : {}),
    ...(originalStart !== null ? { originalStart: originalStart as CalendarTimeInput } : {}),
  });
  return result.ok ? response(result.value, requestId) : errorFor(result.error, requestId);
}

function createEvent(
  privateStore: CalendarPersistence,
  householdStore: CalendarPersistence,
  input: unknown,
  cfg: CalendarConfig,
  requestId: string,
): Response {
  if (isRecord(input) && input.scope !== undefined && input.scope !== "private" && input.scope !== "household") {
    return error(422, "invalid_scope", "calendar writes require one private or household target", requestId);
  }
  const candidate = isRecord(input) ? { ...input, scope: input.scope ?? "private" } : input;
  const parsed = calendarCreateEventSchema.safeParse(candidate);
  if (!parsed.success) return error(422, "malformed", "Calendar create fields are invalid", requestId);
  const persistence = parsed.data.scope === "household" ? householdStore : privateStore;
  const result = createCalendarEvent(parsed.data as CalendarCreateInput, persistence, cfg);
  return result.ok ? response(result.value, requestId) : errorFor(result.error, requestId);
}

function mutateEvent(
  privateStore: CalendarPersistence,
  householdStore: CalendarPersistence,
  eventId: CalendarEventId,
  input: unknown,
  cfg: CalendarConfig,
  requestId: string,
): Response {
  if (!isRecord(input) || (input.operation !== "update" && input.operation !== "delete")) {
    return error(422, "malformed", "Mutation operation must be update or delete", requestId);
  }
  if (input.scope !== undefined && input.scope !== "private" && input.scope !== "household") {
    return error(422, "invalid_scope", "calendar writes require one private or household target", requestId);
  }
  // The path is authoritative. A body cannot redirect a command to another
  // event, and the command service remains the sole mutation authority.
  const candidate = { ...input, eventId };
  const parsed = calendarMutationCommandSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.operation === "create") {
    return error(422, "malformed", "Mutation fields are invalid", requestId);
  }
  const scope = parsed.data.scope ?? "private";
  const persistence = scope === "household" ? householdStore : privateStore;
  const result = mutateCalendarEvent(parsed.data as CalendarMutationCommand, persistence, cfg);
  return result.ok ? response(result.value, requestId) : errorFor(result.error, requestId);
}

function matchRoute(pathname: string): Route | undefined {
  if (pathname === EVENTS) return { kind: "list" };
  const match = new RegExp(`^${EVENTS}/([^/]+)(/mutations)?$`).exec(pathname);
  if (!match) return undefined;
  const rawEventId = match[1];
  if (rawEventId === undefined) return undefined;
  const eventId = safeDecode(rawEventId);
  if (eventId === null || eventId.length === 0) return undefined;
  return match[2] === "/mutations"
    ? { kind: "mutate", eventId: eventId as CalendarEventId }
    : { kind: "get", eventId: eventId as CalendarEventId };
}

function methodAllowed(method: string, route: Route["kind"]): boolean {
  return route === "list"
    ? method === "GET" || method === "POST"
    : route === "get"
      ? method === "GET"
      : method === "POST";
}

function response(body: unknown, requestId: string): Response {
  return Response.json({ version: 2, requestId, body });
}

function errorFor(failure: CalendarError, requestId: string): Response {
  return error(statusFor(failure.code), failure.code, failure.message, requestId);
}

function statusFor(code: CalendarError["code"]): number {
  if (
    [
      "missing_token",
      "expired",
      "signature_invalid",
      "wrong_purpose",
      "user_not_found",
      "invalid_user_record",
    ].includes(code)
  )
    return 401;
  if (
    [
      "invalid_time",
      "invalid_range",
      "range_too_wide",
      "invalid_scope",
      "invalid_mutation_scope",
      "malformed",
    ].includes(code)
  )
    return 422;
  if (["not_found", "occurrence_not_found"].includes(code)) return 404;
  if (code === "forbidden") return 403;
  if (["conflict", "recurrence_conflict"].includes(code)) return 409;
  if (code === "result_too_large") return 413;
  if (code === "aborted") return 409;
  return 503;
}

function error(status: number, code: string, message: string, requestId: string): Response {
  return Response.json({ version: 2, requestId, error: { code, message } }, { status });
}

function tokenErrorCode(code: string): string {
  return code.replaceAll("-", "_");
}

function readBearer(request: Request): string | null {
  const parts = (request.headers.get("authorization") ?? "").trim().split(/\s+/);
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer" && parts[1] ? parts[1] : null;
}

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function closeStore(store: CalendarPersistence | undefined): void {
  try {
    store?.close();
  } catch {
    // Closing is best effort; never replace the request result with a close
    // failure, and never allow one handle to prevent the other from closing.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
