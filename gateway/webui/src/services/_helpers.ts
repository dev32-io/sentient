import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "api", "helpers"]);

// ---------------------------------------------------------------------------
// Shared HTTP helpers — used by auth-api, profile-api, providers-api.
// ---------------------------------------------------------------------------

export interface ApiHttpError {
  status: number;
  code: string;
  /** Server-supplied detail string, when the JSON error body carries one
   *  (e.g. voices' `voice-op-failed` reason). Absent for most error shapes. */
  reason?: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: ApiHttpError };

export const NETWORK_ERROR: ApiHttpError = { status: 0, code: "network-error" };

export function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function errorFromResponse(body: unknown, status: number): ApiHttpError {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as Record<string, unknown>).error === "string"
  ) {
    const code = (body as Record<string, unknown>).error as string;
    const rawReason = (body as Record<string, unknown>).reason;
    return typeof rawReason === "string" ? { status, code, reason: rawReason } : { status, code };
  }
  return { status, code: "unknown-error" };
}

const HTTP_NO_CONTENT = 204;

export async function parseJsonOrError<T>(response: Response): Promise<Result<T>> {
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: { status: response.status, code: "unknown-error" } };
    }
    return { ok: false, error: errorFromResponse(body, response.status) };
  }
  // 204 No Content is success with no body. Don't try to JSON-parse it; that
  // would throw and surface as a phantom "invalid-json" failure even though
  // the operation worked. Used by DELETE /admin/users/:id, POST .../reset-pin,
  // and PUT /admin/secrets/:provider.
  if (response.status === HTTP_NO_CONTENT) {
    return { ok: true, value: undefined as T };
  }
  try {
    const body = await response.json();
    return { ok: true, value: body as T };
  } catch {
    return { ok: false, error: { status: response.status, code: "invalid-json" } };
  }
}

export async function handleFetch<T>(fetchPromise: Promise<Response>): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetchPromise;
  } catch (err: unknown) {
    log.warn("network-error", { error: String(err) });
    return { ok: false, error: NETWORK_ERROR };
  }
  return parseJsonOrError<T>(response);
}

export async function handleBlobFetch(fetchPromise: Promise<Response>): Promise<Result<Blob>> {
  let response: Response;
  try {
    response = await fetchPromise;
  } catch (err: unknown) {
    log.warn("network-error", { error: String(err) });
    return { ok: false, error: NETWORK_ERROR };
  }
  if (!response.ok) {
    return { ok: false, error: { status: response.status, code: `http-${response.status}` } };
  }
  return { ok: true, value: await response.blob() };
}
