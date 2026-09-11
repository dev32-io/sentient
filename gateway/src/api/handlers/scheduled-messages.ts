import {
  SCHEDULES_ROUTE,
  SCHEDULE_CARDS_ROUTE,
  scheduleCreateRequestSchema,
  scheduleCreateResponseSchema,
  scheduleDeleteRequestSchema,
  scheduleDeleteResponseSchema,
  scheduleListQuerySchema,
  scheduleListResponseSchema,
  schedulePatchRequestSchema,
  schedulePatchResponseSchema,
  scheduledSessionCardPageSchema,
} from "@sentient/protocol";
import type { AccessManager } from "../../access/access-manager.js";
import { PrivateScheduleResource } from "../../access/private-schedule-resource.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import type { ScheduleCommands, SchedulingFailure, SchedulingResult } from "../../scheduling/contracts.js";
import type { ScheduleCreateOutcome } from "../../scheduling/service.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";

const ITEM = new RegExp(`^${SCHEDULES_ROUTE}/([^/]+)$`);
const HOUSEHOLD_ID = "home";

export interface ScheduledMessagesHandlerDeps {
  readonly tokens: { validate(token: string): Promise<TokenResult<TokenPayload>> };
  readonly users: Pick<UserStore, "get">;
  readonly accessManager: AccessManager;
  readonly schedules: ScheduleCommands & {
    createDetailed?(
      resource: PrivateScheduleResource,
      request: Parameters<ScheduleCommands["create"]>[1],
      acceptedAt: Date,
    ): Promise<SchedulingResult<ScheduleCreateOutcome>>;
  };
  readonly clock?: () => Date;
}

export function createScheduledMessagesHandler(
  deps: ScheduledMessagesHandlerDeps,
): (request: Request) => Promise<Response> {
  return (request) => handle(deps, request);
}

async function handle(deps: ScheduledMessagesHandlerDeps, request: Request): Promise<Response> {
  const token = bearer(request);
  if (!token) return failure(401, "forbidden", false, "Bearer authentication is required");
  let valid: TokenResult<TokenPayload>;
  try {
    valid = await deps.tokens.validate(token);
  } catch {
    return failure(503, "unavailable", true, "Authentication is unavailable");
  }
  if (!valid.ok) return failure(401, "forbidden", false, "Invalid bearer token");
  let user: Awaited<ReturnType<UserStore["get"]>>;
  try {
    user = await deps.users.get(valid.value.userId);
  } catch {
    return failure(503, "unavailable", true, "User service is unavailable");
  }
  if (!user.ok || !user.value) return failure(401, "forbidden", false, "Authenticated user was not found");
  let resource: PrivateScheduleResource;
  try {
    const principal = createUserPrincipal(valid.value.userId, user.value.role, HOUSEHOLD_ID);
    resource = new PrivateScheduleResource(deps.accessManager.grant(principal, "schedule-private"));
  } catch {
    return failure(401, "forbidden", false, "Authenticated user is invalid");
  }
  if (request.signal.aborted) return failure(503, "unavailable", true, "Request was cancelled");

  const url = new URL(request.url);
  const item = ITEM.exec(url.pathname);
  try {
    if (url.pathname === SCHEDULES_ROUTE) {
      if (request.method === "GET") {
        const parsed = scheduleListQuerySchema.safeParse(query(url));
        if (!parsed.success) return failure(422, "validation", false, "Schedule list query is invalid");
        const result = await deps.schedules.list(resource, parsed.data.cursor, parsed.data.limit ?? 50);
        return result.ok ? checked(scheduleListResponseSchema, result.value) : domainFailure(result.error);
      }
      if (request.method === "POST") {
        const body = await json(request);
        if (body instanceof Response) return body;
        const parsed = scheduleCreateRequestSchema.safeParse(body);
        if (!parsed.success) return failure(422, "validation", false, "Schedule fields are invalid");
        const acceptedAt = (deps.clock ?? (() => new Date()))();
        if (deps.schedules.createDetailed) {
          const result = await deps.schedules.createDetailed(resource, parsed.data, acceptedAt);
          return result.ok
            ? checked(scheduleCreateResponseSchema, result.value, result.value.replayed ? 200 : 201)
            : domainFailure(result.error);
        }
        const result = await deps.schedules.create(resource, parsed.data, acceptedAt);
        return result.ok
          ? checked(scheduleCreateResponseSchema, { schedule: result.value, replayed: false }, 201)
          : domainFailure(result.error);
      }
      return failure(405, "validation", false, "Method is not supported");
    }
    if (url.pathname === SCHEDULE_CARDS_ROUTE) {
      if (request.method !== "GET") return failure(405, "validation", false, "Method is not supported");
      const parsed = scheduleListQuerySchema.safeParse(query(url));
      if (!parsed.success) return failure(422, "validation", false, "Card list query is invalid");
      const result = await deps.schedules.cards(resource, parsed.data.cursor, parsed.data.limit ?? 50);
      return result.ok ? checked(scheduledSessionCardPageSchema, result.value) : domainFailure(result.error);
    }
    if (item) {
      const scheduleId = decode(item[1] ?? "");
      if (!scheduleId) return failure(404, "not_found", false, "Schedule was not found");
      if (request.method !== "PATCH" && request.method !== "DELETE")
        return failure(405, "validation", false, "Method is not supported");
      const body = await json(request);
      if (body instanceof Response) return body;
      if (request.method === "PATCH") {
        const parsed = schedulePatchRequestSchema.safeParse(body);
        if (!parsed.success) return failure(422, "validation", false, "Schedule patch is invalid");
        const result = await deps.schedules.patch(
          resource,
          scheduleId,
          parsed.data,
          (deps.clock ?? (() => new Date()))(),
        );
        return result.ok
          ? checked(schedulePatchResponseSchema, { schedule: result.value })
          : domainFailure(result.error);
      }
      if (request.method === "DELETE") {
        const parsed = scheduleDeleteRequestSchema.safeParse(body);
        if (!parsed.success) return failure(422, "validation", false, "Schedule delete is invalid");
        const result = await deps.schedules.delete(resource, scheduleId, parsed.data.expectedRevision);
        return result.ok
          ? checked(scheduleDeleteResponseSchema, { scheduleId, deleted: true })
          : domainFailure(result.error);
      }
      return failure(405, "validation", false, "Method is not supported");
    }
    return failure(404, "not_found", false, "Schedule route was not found");
  } catch {
    return failure(503, "unavailable", true, "Schedule service is unavailable");
  }
}

function query(url: URL): Record<string, unknown> {
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  return {
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  };
}
async function json(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return failure(422, "validation", false, "Request body is not valid JSON");
  }
}
function checked(schema: { safeParse(value: unknown): { success: boolean } }, body: unknown, status = 200): Response {
  return schema.safeParse(body).success
    ? Response.json(body, { status })
    : failure(500, "internal", false, "Schedule result is invalid");
}
function domainFailure(error: SchedulingFailure): Response {
  const status =
    error.code === "forbidden"
      ? 403
      : error.code === "not_found"
        ? 404
        : error.code === "conflict" || error.code === "idempotency_conflict" || error.code === "claim_lost"
          ? 409
          : error.code === "limit_exceeded"
            ? 413
            : error.code === "validation"
              ? 422
              : 503;
  return failure(
    status,
    error.code === "closed" || error.code === "claim_lost" ? "unavailable" : error.code,
    error.retryable,
    "Schedule operation failed",
  );
}
function failure(status: number, code: string, retryable: boolean, message: string): Response {
  return Response.json({ error: { code, message, retryable } }, { status });
}
function bearer(request: Request): string | undefined {
  const parts = (request.headers.get("authorization") ?? "").trim().split(/\s+/);
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer" ? parts[1] : undefined;
}
function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value) || undefined;
  } catch {
    return undefined;
  }
}
