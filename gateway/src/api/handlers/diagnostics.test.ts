import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import { type DiagnosticsDeps, MAX_BYTES, createDiagnosticsHandler } from "./diagnostics.js";

// --- Test fixtures -----------------------------------------------------------

const OK_TOKEN: TokenResult<TokenPayload> = {
  ok: true,
  value: { userId: "u_test01", isAdmin: false, issuedAt: 0, expiresAt: 9_999_999_999 },
};

const FAIL_TOKEN: TokenResult<TokenPayload> = {
  ok: false,
  error: "expired",
};

function makeDeps(token: TokenResult<TokenPayload> = OK_TOKEN): DiagnosticsDeps {
  return { tokens: { validate: async (_t: string) => token } };
}

function postRequest(
  body: string,
  opts: { bearer?: string; vitalsFile?: string; contentLength?: number } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.vitalsFile !== undefined) headers["x-vitals-file"] = opts.vitalsFile;
  if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);
  return new Request("http://localhost/api/v1/diagnostics/logs", {
    method: "POST",
    headers,
    body,
  });
}

// --- Suite -------------------------------------------------------------------

describe("POST /api/v1/diagnostics/logs — wire contract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "diag-test-"));
    process.env.CLIENT_LOGS_DIR = tmpDir;
  });

  afterEach(() => {
    process.env.CLIENT_LOGS_DIR = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("200 + {ref} for a valid bearer and well-formed body", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    const res = await handler(postRequest("log line 1\nlog line 2", { bearer: "good-token" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ref).toBe("string");
    expect(body.ref).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("writes the log file under <CLIENT_LOGS_DIR>/mobile/", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    await handler(postRequest("hello from mobile", { bearer: "t", vitalsFile: "session-01.log" }));

    const mobileDir = join(tmpDir, "mobile");
    expect(existsSync(mobileDir)).toBe(true);
    const files = readdirSync(mobileDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^u_test01-\d+-[A-Z0-9]{6}\.log$/);
  });

  it("401 when no bearer token is present", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    const res = await handler(
      new Request("http://localhost/api/v1/diagnostics/logs", { method: "POST", body: "data" }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("missing-token");
  });

  it("401 when the token fails validation", async () => {
    const handler = createDiagnosticsHandler(makeDeps(FAIL_TOKEN));
    const res = await handler(postRequest("data", { bearer: "bad-token" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("expired");
  });

  it("400 too-large when body byte length exceeds MAX_BYTES", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    // Build a body just over the limit (MAX_BYTES + 1 ASCII bytes = MAX_BYTES + 1 bytes).
    const bigBody = "x".repeat(MAX_BYTES + 1);
    const res = await handler(postRequest(bigBody, { bearer: "t" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("too-large");
  });

  it("400 too-large when content-length header exceeds MAX_BYTES (pre-buffer check)", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    // Small actual body but declared size over limit — exercises the Content-Length pre-check
    // that rejects the request before the body is buffered.
    const res = await handler(postRequest("small body", { bearer: "t", contentLength: MAX_BYTES + 1 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("too-large");
  });

  it("includes '-crash-' in filename when body contains crash sentinel", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    await handler(postRequest("preamble\n=== CRASH ===\nstack trace...", { bearer: "t", vitalsFile: "app.log" }));
    const files = readdirSync(join(tmpDir, "mobile"));
    expect(files[0]).toContain("-crash-");
  });

  it("includes '-crash-' in filename when x-vitals-file header contains 'crash'", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    await handler(postRequest("normal log content", { bearer: "t", vitalsFile: "crash-report.log" }));
    const files = readdirSync(join(tmpDir, "mobile"));
    expect(files[0]).toContain("-crash-");
  });

  it("405 on non-POST methods", async () => {
    const handler = createDiagnosticsHandler(makeDeps());
    const res = await handler(
      new Request("http://localhost/api/v1/diagnostics/logs", {
        method: "GET",
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(405);
  });
});
