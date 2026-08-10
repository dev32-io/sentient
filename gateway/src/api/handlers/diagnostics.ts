import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatewayStateDir } from "../../config/startup-config.js";
import { getLog } from "../../logging/logger.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";

const log = getLog(["sentient", "api", "diagnostics"]);

// --- HTTP status constants ---------------------------------------------------

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL = 500;

// --- Upload constants --------------------------------------------------------

/** Maximum accepted body size in bytes. Rejects oversized uploads before allocation. */
export const MAX_BYTES = 64 * 1024 * 1024; // 64 MB

/** Number of hex chars taken from UUID (without dashes) for the short ref. */
const REF_LEN = 6;

/** Sentinel in crash logs: presence triggers "-crash-" suffix in filename. */
const CRASH_SENTINEL = "=== CRASH ===";

/**
 * Sub-path of the client-log dir under the gateway's writable state root
 * (`~/.sentient/gateway/clientLogs`), overridable by `CLIENT_LOGS_DIR`.
 *
 * Uploaded logs are mutable STATE, so they live under the user-owned state
 * root — the same rule the gateway's own log dir follows. This used to default
 * to "/app/clientLogs", the path the dir was MOUNTED at back when the gateway
 * shipped as a container; the native binary has no /app and `/` is read-only,
 * so every upload 500'd on `EROFS: mkdir '/app'` and mobile vitals was dead in
 * dev and prod alike. Resolve through `gatewayStateDir` — never hardcode a
 * writable absolute path.
 *
 * Growth of clientLogs/ is operator-managed: external rotation/cleanup is
 * deferred to the operator (e.g. logrotate, cron). No automatic pruning here.
 */
const CLIENT_LOGS_STATE_DIR = "clientLogs";

/** Sub-directory under CLIENT_LOGS_DIR for mobile uploads. */
const MOBILE_SUBDIR = "mobile";

/** Filename header sent by the KMP VitalsUploader. */
const VITALS_FILE_HEADER = "x-vitals-file";

/** Max safe length for path segments derived from user input. */
const SAFE_SEGMENT_MAX = 80;

// --- Dep interface -----------------------------------------------------------

export interface DiagnosticsDeps {
  tokens: { validate: (token: string) => Promise<TokenResult<TokenPayload>> };
}

// --- Handler -----------------------------------------------------------------

export function createDiagnosticsHandler(deps: DiagnosticsDeps): (request: Request) => Promise<Response> {
  return (request) => handleDiagnostics(deps, request);
}

async function handleDiagnostics(deps: DiagnosticsDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(HTTP_METHOD_NOT_ALLOWED, "method-not-allowed", "Only POST is accepted");
  }

  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token", "Bearer token required");

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("diagnostics.token-rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error, "Invalid token");
  }

  const userId = valid.value.userId;

  // Reject well-behaved oversized uploads before allocating the body buffer.
  const declaredLen = Number(request.headers.get("content-length") ?? 0);
  if (declaredLen > MAX_BYTES) {
    log.warn("diagnostics.too-large", { userId, bytes: declaredLen });
    return jsonError(HTTP_BAD_REQUEST, "too-large", "Log body exceeds limit");
  }

  // Read as ArrayBuffer for a byte-accurate size guard (avoids UTF-16 code-unit inflation).
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    log.warn("diagnostics.too-large", { userId, bytes: buf.byteLength });
    return jsonError(HTTP_BAD_REQUEST, "too-large", "Log body exceeds limit");
  }
  const body = new TextDecoder().decode(buf);

  const fileHint = safe(request.headers.get(VITALS_FILE_HEADER) ?? "session");
  // Primary: filename hint from the uploader. Fallback: body-sentinel scan for when
  // the x-vitals-file header is absent or stripped by an intermediate proxy.
  const crashed = fileHint.includes("crash") || body.includes(CRASH_SENTINEL);
  const ref = makeRef();
  const ts = Date.now();
  const crashTag = crashed ? "-crash" : "";
  const name = `${safe(userId)}-${ts}${crashTag}-${ref}.log`;

  // Resolved per request, not at module load, so an env change (tests, an
  // operator override) is honoured without re-importing the module.
  const clientLogsDir = process.env.CLIENT_LOGS_DIR ?? gatewayStateDir(CLIENT_LOGS_STATE_DIR);
  const dir = join(clientLogsDir, MOBILE_SUBDIR);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), `# fileHint=${fileHint}\n${body}`, { mode: 0o644 });
  } catch (e) {
    log.warn("diagnostics.write-failed", { userId, reason: e instanceof Error ? e.message : "unknown" });
    return jsonError(HTTP_INTERNAL, "write-failed", "Could not persist diagnostic log");
  }

  log.info("diagnostics.received", { userId, bytes: buf.byteLength, crashed, ref, name });
  return new Response(JSON.stringify({ ref }), {
    status: HTTP_OK,
    headers: { "content-type": "application/json" },
  });
}

// --- Helpers -----------------------------------------------------------------

/** Returns the bearer token string, or null if the header is absent/malformed. */
function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function jsonError(status: number, code: string, detail: string): Response {
  return Response.json({ error: code, detail }, { status });
}

/** Sanitizes a user-supplied string to safe filename characters. Prevents
 *  path traversal via `..`, spaces, or shell metacharacters. */
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, SAFE_SEGMENT_MAX);
}

/** Derives a short uppercase ref code from a fresh UUID. */
function makeRef(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, REF_LEN).toUpperCase();
}
