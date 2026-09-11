import {
  type Schedule,
  type ScheduleCreateRequest,
  type ScheduleListResponse,
  type SchedulePatchRequest,
  type ScheduledSessionCardPage,
  scheduleCreateResponseSchema,
  scheduleDeleteResponseSchema,
  scheduleListResponseSchema,
  schedulePatchResponseSchema,
  scheduledSessionCardPageSchema,
} from "@sentient/protocol";
import type { z } from "zod";

export interface ScheduleApiError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}
export type ScheduleApiResult<T> = { ok: true; value: T } | { ok: false; error: ScheduleApiError };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SchedulesApi {
  list(token: string): Promise<ScheduleApiResult<ScheduleListResponse>>;
  create(token: string, input: ScheduleCreateRequest): Promise<ScheduleApiResult<Schedule>>;
  patch(token: string, id: string, input: SchedulePatchRequest): Promise<ScheduleApiResult<Schedule>>;
  delete(token: string, id: string, revision: number): Promise<ScheduleApiResult<void>>;
  cards(token: string): Promise<ScheduleApiResult<ScheduledSessionCardPage>>;
}

function failure(status: number, body?: unknown): ScheduleApiResult<never> {
  const candidate =
    body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : undefined;
  const error = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
  return {
    ok: false,
    error: {
      status,
      code: typeof error.code === "string" ? error.code : status === 0 ? "network" : "invalid-response",
      message: typeof error.message === "string" ? error.message : "The request could not be completed.",
      retryable: error.retryable === true || status === 0 || status >= 500,
    },
  };
}

export function createSchedulesApi(config: { baseUrl?: string; fetch?: Fetcher } = {}): SchedulesApi {
  const base = config.baseUrl ?? "";
  const fetcher = config.fetch ?? globalThis.fetch.bind(globalThis);
  async function call<T>(
    token: string,
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<ScheduleApiResult<T>> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      });
    } catch {
      return failure(0);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure(response.status);
    }
    if (!response.ok) return failure(response.status, body);
    const parsed = schema.safeParse(body);
    return parsed.success ? { ok: true, value: parsed.data } : failure(response.status);
  }
  return {
    list: (token) => call(token, "/api/v1/schedules", scheduleListResponseSchema),
    async create(token, input) {
      const result = await call(token, "/api/v1/schedules", scheduleCreateResponseSchema, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return result.ok ? { ok: true, value: result.value.schedule } : result;
    },
    async patch(token, id, input) {
      const result = await call(token, `/api/v1/schedules/${encodeURIComponent(id)}`, schedulePatchResponseSchema, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      return result.ok ? { ok: true, value: result.value.schedule } : result;
    },
    async delete(token, id, revision) {
      const result = await call(token, `/api/v1/schedules/${encodeURIComponent(id)}`, scheduleDeleteResponseSchema, {
        method: "DELETE",
        body: JSON.stringify({ expectedRevision: revision }),
      });
      return result.ok ? { ok: true, value: undefined } : result;
    },
    cards: (token) => call(token, "/api/v1/scheduled-session-cards", scheduledSessionCardPageSchema),
  };
}
