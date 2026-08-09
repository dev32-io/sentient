// DeepMemoryClient — the gateway-side typed HTTP boundary onto the
// DeepMemoryService (Memory System spec §5). The service is a dumb index
// engine (scope ids + text in, ranked hits out); it knows nothing about users
// or sessions. Retriever, dreamer, and tools depend on THIS interface, never on
// HTTP details.
//
// Two auth planes (spec §5.2): admin (register-scope, purge, rebuild) carries
// the admin token; data (upsert, search, set-status) carries the data token.
// `/health` needs no auth but sends the data token anyway — harmless and keeps
// one code path.
//
// Never throws across the boundary (error-handling rule): every call returns a
// typed `Result<T, ClientError>`. A dead index engine must not crash a caller
// mid-loop — the degradation model (spec §10) is non-fatal by design. Error
// mapping: connection failure → `unavailable`, deadline → `timeout`, HTTP 409 →
// `rebuild_required` (embedding-model / schema mismatch, spec §5.3), other 4xx →
// `refused` (carrying the server's error string), 5xx → `unavailable`.
//
// No memory content in logs (global constraint): query text and entry text are
// NEVER logged — only endpoint, scope ids, k, counts, elapsed ms.

import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "memory", "deep-client"]);

const BEARER_PREFIX = "Bearer ";
const HTTP_CONFLICT = 409;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;

// --- Wire types (spec §5.4) --------------------------------------------------

/** `active` searches by spark; `memory_recall` may include historical (labeled). */
export type EntryStatus = "active" | "superseded" | "stale";

/** Shared-scope visibility (spec §9). Absent on private scopes. */
export type EntryAudience = "all" | "adults";

/** Where the canonical text lives — journals and file sections. */
export interface SourceRef {
  file?: string;
  heading?: string;
}

/** Which session an entry was distilled from — enables purge-by-session (§3.8). */
export interface SessionRef {
  sessionId: string;
  entrySpan?: [number, number];
}

/**
 * Index entry schema — spec §5.4 verbatim, plus `authorUserId?` (shared-scope
 * attribution). `kind` is an open string set: unknown kinds store and filter
 * fine, so it is a plain string, not a closed union.
 */
export interface IndexEntry {
  id: string;
  kind: string;
  text: string;
  timestamp: string;
  scope: string;
  sourceRef: SourceRef;
  sessionRef?: SessionRef;
  provenance: string;
  audience?: EntryAudience;
  status: EntryStatus;
  statusReason?: string;
  supersededBy?: string;
  createdAt: string;
  statusChangedAt: string;
  authorUserId?: string;
}

/** A ranked search result — cosine `similarity` (0–1) is the relevance gate. */
export interface Hit {
  entry: IndexEntry;
  similarity: number;
  rank: number;
}

/** Search filters (spec §5.2). */
export interface SearchFilters {
  timeRange?: { from?: string; to?: string };
  kinds?: string[];
  statuses?: EntryStatus[];
}

export interface SearchRequest {
  scopeIds: string[];
  query: string;
  k: number;
  filters?: SearchFilters;
}

/** Purge selector (spec §5.2) — any one facet identifies the rows to hard-remove. */
export interface PurgeFilter {
  sessionId?: string;
  sourceRef?: SourceRef;
  provenance?: string;
  timeRange?: { from?: string; to?: string };
}

/**
 * `/health` payload — unified service health contract (camelCase). Reports the
 * embedding model id (null until the index is initialized) + index schema
 * version (§5.3).
 */
export interface HealthInfo {
  status: string;
  version: string;
  embeddingModel: string | null;
  indexSchemaVersion: number;
}

/**
 * Typed boundary error — the kind drives caller degradation; `message` carries
 * the server's error string only on `refused` (a 4xx the caller can surface).
 */
export interface ClientError {
  kind: "unavailable" | "timeout" | "rebuild_required" | "refused";
  message?: string;
}

export interface DeepMemoryClient {
  registerScope(scopeId: string, indexPath: string): Promise<Result<void, ClientError>>;
  upsert(scopeId: string, entries: IndexEntry[]): Promise<Result<void, ClientError>>;
  search(req: SearchRequest): Promise<Result<Hit[], ClientError>>;
  setStatus(scopeId: string, ids: string[], status: EntryStatus, reason: string): Promise<Result<void, ClientError>>;
  purge(scopeId: string, filter: PurgeFilter): Promise<Result<void, ClientError>>;
  rebuild(scopeId: string): Promise<Result<void, ClientError>>;
  health(): Promise<Result<HealthInfo, ClientError>>;
}

export interface DeepMemoryClientOptions {
  baseUrl: string;
  adminToken: string;
  dataToken: string;
  requestTimeoutMs: number;
}

type Plane = "admin" | "data";

interface RawResponse {
  status: number;
  body: unknown;
}

// --- Error classification ----------------------------------------------------

function isTimeoutError(err: unknown): boolean {
  // `AbortSignal.timeout` rejects fetch with a DOMException named "TimeoutError"
  // (some runtimes surface "AbortError"). Either means the deadline fired.
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

function mapStatusError(status: number, body: unknown): ClientError {
  if (status === HTTP_CONFLICT) {
    return { kind: "rebuild_required" };
  }
  if (status >= HTTP_CLIENT_ERROR_MIN && status <= HTTP_CLIENT_ERROR_MAX) {
    return { kind: "refused", message: extractServerError(body) };
  }
  // 5xx — service-side failure; treat as a degraded/unavailable index engine.
  return { kind: "unavailable", message: `service returned ${status}` };
}

function extractServerError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error: unknown }).error;
    if (typeof value === "string") {
      return value;
    }
  }
  return "request refused";
}

// --- Client ------------------------------------------------------------------

/**
 * Builds a DeepMemoryClient bound to one service origin and one token pair.
 * Every call is deadline-bounded by `requestTimeoutMs` (spec §5.1).
 */
export function createDeepMemoryClient(opts: DeepMemoryClientOptions): DeepMemoryClient {
  const { baseUrl, adminToken, dataToken, requestTimeoutMs } = opts;
  const origin = baseUrl.replace(/\/+$/, "");

  function tokenFor(plane: Plane): string {
    return plane === "admin" ? adminToken : dataToken;
  }

  async function post(endpoint: string, plane: Plane, payload: unknown): Promise<Result<RawResponse, ClientError>> {
    return request(endpoint, plane, "POST", payload);
  }

  async function request(
    endpoint: string,
    plane: Plane,
    method: "GET" | "POST",
    payload: unknown,
  ): Promise<Result<RawResponse, ClientError>> {
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `${BEARER_PREFIX}${tokenFor(plane)}`,
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    };
    if (method === "POST") {
      init.body = JSON.stringify(payload ?? {});
    }

    let response: Response;
    try {
      response = await fetch(`${origin}${endpoint}`, init);
    } catch (err: unknown) {
      // Deadline vs. connection failure — never let either escape as a throw.
      const kind = isTimeoutError(err) ? "timeout" : "unavailable";
      return { ok: false, error: { kind } };
    }

    const body = await parseBody(response);
    if (!response.ok) {
      return { ok: false, error: mapStatusError(response.status, body) };
    }
    return { ok: true, value: { status: response.status, body } };
  }

  async function search(req: SearchRequest): Promise<Result<Hit[], ClientError>> {
    const started = Date.now();
    const result = await post("/search", "data", req);
    const elapsedMs = Date.now() - started;
    if (!result.ok) {
      logCall("/search", { scopeIds: req.scopeIds, k: req.k }, elapsedMs, result.error);
      return result;
    }
    const hits = readHits(result.value.body);
    logCall("/search", { scopeIds: req.scopeIds, k: req.k, hits: hits.length }, elapsedMs);
    return { ok: true, value: hits };
  }

  async function health(): Promise<Result<HealthInfo, ClientError>> {
    const started = Date.now();
    const result = await request("/health", "data", "GET", undefined);
    const elapsedMs = Date.now() - started;
    if (!result.ok) {
      logCall("/health", {}, elapsedMs, result.error);
      return result;
    }
    const health = readHealth(result.value.body);
    if (!health) {
      const error: ClientError = { kind: "refused", message: "malformed health payload" };
      logCall("/health", {}, elapsedMs, error);
      return { ok: false, error };
    }
    logCall("/health", {}, elapsedMs);
    return { ok: true, value: health };
  }

  async function mutate(
    endpoint: string,
    plane: Plane,
    payload: unknown,
    logFields: Record<string, unknown>,
  ): Promise<Result<void, ClientError>> {
    const started = Date.now();
    const result = await post(endpoint, plane, payload);
    const elapsedMs = Date.now() - started;
    if (!result.ok) {
      logCall(endpoint, logFields, elapsedMs, result.error);
      return result;
    }
    logCall(endpoint, logFields, elapsedMs);
    return { ok: true, value: undefined };
  }

  return {
    registerScope: (scopeId, indexPath) =>
      mutate("/register-scope", "admin", { scopeId, indexPath }, { scopeIds: [scopeId] }),
    upsert: (scopeId, entries) =>
      mutate(
        "/upsert",
        "data",
        { scopeId, entries },
        {
          scopeIds: [scopeId],
          entries: entries.length,
        },
      ),
    search,
    setStatus: (scopeId, ids, status, reason) =>
      mutate(
        "/set-status",
        "data",
        { scopeId, ids, status, reason },
        {
          scopeIds: [scopeId],
          ids: ids.length,
          status,
        },
      ),
    purge: (scopeId, filter) => mutate("/purge", "admin", { scopeId, filter }, { scopeIds: [scopeId] }),
    rebuild: (scopeId) => mutate("/rebuild", "admin", { scopeId }, { scopeIds: [scopeId] }),
    health,
  };
}

// --- Response readers (tolerant — the service owns the exact envelope) --------

async function parseBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function readHits(body: unknown): Hit[] {
  if (body && typeof body === "object" && "hits" in body) {
    const hits = (body as { hits: unknown }).hits;
    if (Array.isArray(hits)) {
      return hits as Hit[];
    }
  }
  if (Array.isArray(body)) {
    return body as Hit[];
  }
  return [];
}

/**
 * Validates the `/health` wire contract by presence + type, never a bare cast.
 * `embeddingModel` is nullable by contract (null until the index is built);
 * a missing/malformed field yields `null` so the caller maps it to `refused`.
 */
function readHealth(body: unknown): HealthInfo | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  const { status, version, embeddingModel, indexSchemaVersion } = record;
  if (typeof status !== "string" || typeof version !== "string") {
    return null;
  }
  if (embeddingModel !== null && typeof embeddingModel !== "string") {
    return null;
  }
  if (typeof indexSchemaVersion !== "number") {
    return null;
  }
  return { status, version, embeddingModel, indexSchemaVersion };
}

// --- Logging (never logs query or entry text — global constraint) ------------

function logCall(endpoint: string, fields: Record<string, unknown>, elapsedMs: number, error?: ClientError): void {
  const properties = { endpoint, elapsedMs, ...fields };
  if (error) {
    log.debug("deep-memory call failed", { ...properties, errorKind: error.kind });
    return;
  }
  log.debug("deep-memory call", properties);
}
