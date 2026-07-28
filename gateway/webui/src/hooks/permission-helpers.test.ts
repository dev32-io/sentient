import type { PermissionRequestItem } from "@sentient/web-sdk";
import { describe, expect, it } from "vitest";
import { reducePermissionPrompt } from "./permission-helpers.ts";

const PROMPT_TTL_MS = 120_000;

function makeRequest(overrides: Partial<PermissionRequestItem> = {}): PermissionRequestItem {
  return {
    requestId: "req-1",
    toolCallId: "call-1",
    toolName: "write_file",
    args: { path: "/tmp/x" },
    description: "Write to /tmp/x",
    expiresAtMs: Date.now() + PROMPT_TTL_MS,
    ...overrides,
  };
}

describe("reducePermissionPrompt", () => {
  it("opens the dialog on a request event", () => {
    const request = makeRequest();
    const next = reducePermissionPrompt(null, { type: "request", request });
    expect(next).toBe(request);
  });

  it("closes the dialog when resolved matches the pending requestId", () => {
    const request = makeRequest();
    const opened = reducePermissionPrompt(null, { type: "request", request });
    const next = reducePermissionPrompt(opened, { type: "resolved", requestId: "req-1", outcome: "allowed" });
    expect(next).toBeNull();
  });

  it("closes the dialog on a server-driven timeout outcome with no prior user action", () => {
    const request = makeRequest();
    const opened = reducePermissionPrompt(null, { type: "request", request });
    const next = reducePermissionPrompt(opened, { type: "resolved", requestId: "req-1", outcome: "timeout" });
    expect(next).toBeNull();
  });

  it("ignores a resolved event for a requestId that isn't the pending one", () => {
    const request = makeRequest({ requestId: "req-1" });
    const opened = reducePermissionPrompt(null, { type: "request", request });
    const next = reducePermissionPrompt(opened, { type: "resolved", requestId: "req-stale", outcome: "timeout" });
    expect(next).toBe(opened);
  });

  it("a resolved event with no dialog open stays closed", () => {
    const next = reducePermissionPrompt(null, { type: "resolved", requestId: "req-1", outcome: "denied" });
    expect(next).toBeNull();
  });
});
