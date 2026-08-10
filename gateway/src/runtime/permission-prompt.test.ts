// ONE prompt's settle-once FSM (spec §5.3/§7.1) — what both the client dialog
// and the ReAct loop's awaited dispatch rest on: a prompt settles EXACTLY once,
// and every settlement no human made is a DENY. Zero-cost: one timer, no I/O.
//
// The MAP of prompts is not this module's and is tested apart
// (session-permission-broker.test.ts): who may answer is a session question.

import { describe, expect, it } from "bun:test";
import type { PermissionSettlement } from "./permission-prompt.js";
import { ABORTED_MESSAGE, SESSION_CLOSED_MESSAGE, TIMEOUT_MESSAGE, openPermissionPrompt } from "./permission-prompt.js";
import type { PermissionRequest } from "./turn-emitter.js";

const ANSWERING_ATTACHMENT = "at_window-b";
/** Short enough to await, long enough not to race a synchronous settle. */
const SHORT_DEADLINE_MS = 20;

function permissionRequest(expiresInMs: number): PermissionRequest {
  return {
    requestId: "req_1",
    toolCallId: "call-1",
    toolName: "delegateTask",
    args: { agent: "hermes", taskPrompt: "look something up" },
    description: "Delegating to another agent runs work on your behalf",
    expiresAtMs: Date.now() + expiresInMs,
  };
}

function openPrompt(options: { expiresInMs?: number; signal?: AbortSignal } = {}) {
  const settlements: PermissionSettlement[] = [];
  const prompt = openPermissionPrompt({
    request: permissionRequest(options.expiresInMs ?? 60_000),
    signal: options.signal ?? new AbortController().signal,
    onSettled: (settlement) => settlements.push(settlement),
  });
  return { prompt, settlements };
}

describe("PermissionPrompt — one prompt, settled once", () => {
  it("resolves allow on an explicit allowed settlement", async () => {
    const { prompt } = openPrompt();

    expect(prompt.settle({ reason: "allowed", attachmentId: ANSWERING_ATTACHMENT })).toBe(true);

    await expect(prompt.decided).resolves.toEqual({ allow: true });
  });

  it("SECURITY: refuses a second settlement instead of re-deciding the first", async () => {
    const { prompt, settlements } = openPrompt();

    expect(prompt.settle({ reason: "denied", attachmentId: ANSWERING_ATTACHMENT })).toBe(true);
    expect(prompt.settle({ reason: "allowed", attachmentId: "at_window-a" })).toBe(false);

    await expect(prompt.decided).resolves.toEqual({ allow: false });
    // The settled hook ran ONCE — a second run would emit a second
    // `permission.resolved` for a prompt that is already gone.
    expect(settlements).toHaveLength(1);
  });

  it("SECURITY: settles the deadline as an unanswerable deny, never an implicit approval", async () => {
    const { prompt } = openPrompt({ expiresInMs: SHORT_DEADLINE_MS });

    await expect(prompt.decided).resolves.toEqual({ allow: false, unavailable: TIMEOUT_MESSAGE });
  });

  it("settles as an unanswerable deny when the turn is aborted underneath the dialog", async () => {
    const controller = new AbortController();
    const { prompt } = openPrompt({ signal: controller.signal });

    controller.abort();

    await expect(prompt.decided).resolves.toEqual({ allow: false, unavailable: ABORTED_MESSAGE });
  });

  it("carries the teardown reason to the model when the session settles it closed", async () => {
    const { prompt } = openPrompt();

    prompt.settle({ reason: "closed", attachmentId: null, unavailable: SESSION_CLOSED_MESSAGE });

    await expect(prompt.decided).resolves.toEqual({ allow: false, unavailable: SESSION_CLOSED_MESSAGE });
  });
});
