import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../../logging/logger.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";

const log = getLog(["sentient", "api", "diagnostics"]);

// --- HTTP status constants ---------------------------------------------------

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD_NOT_ALLOWED = 405;

// --- Upload constants --------------------------------------------------------

/** Maximum accepted body size (bytes). Rejects oversized uploads early. */
const MAX_BYTES = 64 * 1024 * 1024; // 64 MB

/** Number of hex chars taken from UUID (without dashes) for the short ref. */
const REF_LEN = 6;

/** Sentinel in crash logs: presence triggers "-crash-" suffix in filename. */
const CRASH_SENTINEL = "=== CRASH ===";

/** Default base directory for client log files (overridden by env in tests). */
const DEFAULT_CLIENT_LOGS_DIR = "/app/clientLogs";

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

  const body = await request.text();
  if (body.length > MAX_BYTES) {
    log.warn("diagnostics.too-large", { userId, bytes: body.length });
    return jsonError(HTTP_BAD_REQUEST, "too-large", "Log body exceeds 64 MB limit");
  }

  const fileHint = safe(request.headers.get(VITALS_FILE_HEADER) ?? "session");
  const crashed = fileHint.includes("crash") || body.includes(CRASH_SENTINEL);
  const ref = makeRef();
  const ts = Date.now();
  const crashTag = crashed ? "-crash" : "";
  const name = `${safe(userId)}-${ts}${crashTag}-${ref}.log`;

  const clientLogsDir = process.env.CLIENT_LOGS_DIR ?? DEFAULT_CLIENT_LOGS_DIR;
  const dir = join(clientLogsDir, MOBILE_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `# fileHint=${fileHint}\n${body}`, { mode: 0o644 });

  log.info("diagnostics.received", { userId, bytes: body.length, crashed, ref, name });
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
