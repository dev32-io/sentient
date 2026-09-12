#!/usr/bin/env bun
import { chmod, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { assertLoopbackFixtureTarget } from "../design-refresh/fixture.ts";
import { safeLogStages } from "./probe-support.ts";

type LocalFetchInit = RequestInit & { tls?: { rejectUnauthorized: boolean } };
type Binding = { sessionId: string; attachmentGeneration: number };

const arg = (name: string, required = true): string | undefined => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`missing ${name}`);
  return value;
};
const env = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const target = assertLoopbackFixtureTarget(arg("--target") ?? "", "local");
const userId = arg("--user-id") ?? "";
const output = arg("--output") ?? "";
const gatewayLog = arg("--gateway-log", false);
const timeoutMs = Number(arg("--timeout-ms", false) ?? "180000");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new Error("invalid --timeout-ms");

async function localFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, target);
  const options: LocalFetchInit = { ...init };
  if (url.protocol === "https:") options.tls = { rejectUnauthorized: false };
  return fetch(url, options);
}

const authSchema = z.object({ token: z.string().min(1) }).passthrough();
const schedulesSchema = z.object({ schedules: z.array(z.object({ scheduleId: z.string() }).passthrough()) }).passthrough();
async function login(): Promise<string> {
  const response = await localFetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, pin: env("SCHEDULE_QA_USER_PIN") }),
  });
  if (!response.ok) throw new Error(`fixture login failed: HTTP ${response.status}`);
  return authSchema.parse(await response.json()).token;
}
async function scheduleCount(token: string): Promise<number> {
  const response = await localFetch("/api/v1/schedules?limit=100", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`schedule list failed: HTTP ${response.status}`);
  return schedulesSchema.parse(await response.json()).schedules.length;
}
async function status(path: string): Promise<number> {
  return (await localFetch(path)).status;
}

const token = await login();
const before = await scheduleCount(token);
const readiness = { health: await status("/health"), ready: await status("/ready") };
const wsUrl = new URL("/api/v1/ws", target);
wsUrl.protocol = target.protocol === "https:" ? "wss:" : "ws:";

let binding: Binding | null = null;
let promptSent = false;
let toolCallId: string | null = null;
let toolName: string | null = null;
let validationRejected = false;
let approvalRequested = false;
let approvalResolved: "allowed" | "denied" | "timeout" | null = null;
let toolStatus: "running" | "done" | "error" | null = null;
let settled = false;

// Local stack serves a self-signed certificate. `fetch` above opts out of
// certificate verification for this already loopback-validated target; apply
// same local-only policy to WebSocket or every HTTPS probe fails before auth.
const socket = new WebSocket(wsUrl, target.protocol === "https:" ? { tls: { rejectUnauthorized: false } } : undefined);
const completed = new Promise<void>((resolve, reject) => {
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(error);
  };
  const timeout = setTimeout(() => fail(new Error("model probe timed out")), timeoutMs);
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve();
  };
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
  socket.addEventListener("error", () => fail(new Error("model probe websocket failed")));
  socket.addEventListener("close", () => fail(new Error("model probe websocket closed before terminal turn")));
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = message.type;
    if (type === "auth.ok") {
      socket.send(
        JSON.stringify({
          type: "session.configure",
          capabilities: { supports: ["text.input", "conversation.history", "stream.resume"] },
          clientType: "webui",
          deviceId: `qa-${crypto.randomUUID()}`,
          surfaceId: `qa-${crypto.randomUUID()}`,
        }),
      );
      return;
    }
    if (type === "session.attached") {
      const parsed = z
        .object({ sessionId: z.string().min(1), generation: z.number().int().positive() })
        .safeParse(message);
      if (parsed.success) binding = { sessionId: parsed.data.sessionId, attachmentGeneration: parsed.data.generation };
    }
    if ((type === "session.draft" || type === "session.ready") && !promptSent) {
      promptSent = true;
      socket.send(JSON.stringify({ type: "text.input", text: env("SCHEDULE_QA_PROMPT"), pendingId: crypto.randomUUID() }));
      return;
    }
    if (type === "permission.request") {
      const parsed = z
        .object({ requestId: z.string(), toolCallId: z.string(), toolName: z.string() })
        .safeParse(message);
      if (!parsed.success || parsed.data.toolName !== "scheduled_message_create") return;
      approvalRequested = true;
      toolCallId = parsed.data.toolCallId;
      toolName = parsed.data.toolName;
      socket.send(
        JSON.stringify({
          type: "permission.response",
          requestId: parsed.data.requestId,
          approved: true,
          ...(binding ?? {}),
        }),
      );
      return;
    }
    if (type === "permission.resolved") {
      const parsed = z.object({ outcome: z.enum(["allowed", "denied", "timeout"]) }).safeParse(message);
      if (parsed.success) approvalResolved = parsed.data.outcome;
      return;
    }
    if (type === "tasklist.state" && Array.isArray(message.items)) {
      for (const item of message.items) {
        const parsed = z
          .object({ id: z.string(), toolName: z.string(), status: z.enum(["running", "done", "error"]) })
          .safeParse(item);
        if (!parsed.success || parsed.data.toolName !== "scheduled_message_create") continue;
        toolCallId = parsed.data.id;
        toolName = parsed.data.toolName;
        toolStatus = parsed.data.status;
        if (parsed.data.status === "error" && !approvalRequested) validationRejected = true;
      }
      return;
    }
    if (type === "turn.completed" || type === "turn.aborted") finish();
  });
});

try {
  await completed;
} finally {
  socket.close();
}
const after = await scheduleCount(token);
const logStages = gatewayLog ? safeLogStages(await readFile(gatewayLog, "utf8"), toolCallId) : [];
if (logStages.includes("tool-broker.dispatch.native.invalid-args")) validationRejected = true;
const serviceCode = after > before ? "success" : null;
const report = {
  schemaVersion: 1,
  testedCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  readiness,
  tool: { name: toolName, callId: toolCallId },
  stages: {
    ordinaryChatSubmitted: promptSent,
    modelToolJsonObserved: toolCallId !== null,
    nativeValidationRejected: validationRejected,
    approvalRequested,
    approvalResolved,
    toolStatus,
    gatewayDiagnostics: logStages,
  },
  validation: { schemaIssuePaths: [] as string[] },
  service: {
    code: serviceCode,
    finalKnownErrorCode: null as string | null,
    scheduleCountBefore: before,
    scheduleCountAfter: after,
  },
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(output, 0o600);
process.stdout.write(`${output}\n`);
