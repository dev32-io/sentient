#!/usr/bin/env bun
// Headless smoke test for the cerebrum architecture.
//
// Connects to a running gateway via WebSocket, advertises capabilities,
// sends a text.input, and verifies the full cycle lifecycle:
//   cycle.started -> message.delta OR connector.audio.start -> cycle.completed
//
// Exits 0 on success, 1 on timeout or protocol error.
//
// Usage: bun run scripts/smoke-cerebrum.ts [--url wss://...] [--token ...]

import { parseArgs } from "node:util";

const DEFAULT_URL = "ws://localhost:8888/api/v1/ws";
const TIMEOUT_MS = 30_000;

interface SmokeResult {
  ok: boolean;
  events: string[];
  error?: string;
}

async function runSmoke(url: string, token: string | undefined): Promise<SmokeResult> {
  const events: string[] = [];
  return new Promise((resolve) => {
    const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false, events, error: "timeout" });
    }, TIMEOUT_MS);

    let sawCycleStarted = false;
    let sawOutputConnector = false;
    let sawCycleCompleted = false;

    ws.onopen = () => {
      events.push("ws.open");
      ws.send(
        JSON.stringify({
          type: "session.configure",
          language: "en",
          capabilities: {
            supports: ["text.input", "audio.output", "cognition.status"],
          },
        }),
      );
    };

    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "<binary>";
      if (raw === "<binary>") {
        events.push("binary.frame");
        return;
      }
      try {
        const msg = JSON.parse(raw) as { type: string; reason?: string; message?: string };
        events.push(msg.type);
        if (msg.type === "auth.ok") {
          // auth.ok received — nothing to do, wait for session.configure response
        } else if (msg.type === "session.ready") {
          // Send text input now
          ws.send(JSON.stringify({ type: "text.input", text: "Hello, smoke test." }));
        } else if (msg.type === "cycle.started") {
          sawCycleStarted = true;
        } else if (msg.type === "message.delta" || msg.type === "connector.audio.start") {
          sawOutputConnector = true;
        } else if (msg.type === "cycle.completed") {
          sawCycleCompleted = true;
          if (sawCycleStarted && sawOutputConnector) {
            clearTimeout(timer);
            ws.close();
            resolve({ ok: true, events });
          }
        } else if (msg.type === "cycle.aborted" || msg.type === "error") {
          clearTimeout(timer);
          ws.close();
          resolve({
            ok: false,
            events,
            error: `${msg.type}: ${msg.reason ?? msg.message ?? "unknown"}`,
          });
        }
      } catch (err) {
        events.push(`parse.error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    ws.onerror = (ev) => {
      events.push(`ws.error: ${String(ev)}`);
    };

    ws.onclose = () => {
      events.push("ws.close");
      clearTimeout(timer);
      if (!sawCycleCompleted) {
        resolve({ ok: false, events, error: "closed before cycle.completed" });
      }
    };
  });
}

const { values } = parseArgs({
  options: {
    url: { type: "string", default: DEFAULT_URL },
    token: { type: "string", default: process.env.SENTIENT_TOKEN ?? "" },
  },
});

const url = values.url ?? DEFAULT_URL;
const token = values.token || undefined;

// biome-ignore lint/suspicious/noConsoleLog: CLI tool output
console.log(`[smoke] connecting to ${url}`);
if (token) {
  // biome-ignore lint/suspicious/noConsoleLog: CLI tool output
  console.log("[smoke] using token from --token / SENTIENT_TOKEN");
} else {
  // biome-ignore lint/suspicious/noConsoleLog: CLI tool output
  console.log("[smoke] no token — anonymous session");
}

const result = await runSmoke(url, token);

// biome-ignore lint/suspicious/noConsoleLog: CLI tool output
console.log(`[smoke] events seen: ${result.events.join(", ")}`);
if (result.ok) {
  // biome-ignore lint/suspicious/noConsoleLog: CLI tool output
  console.log("[smoke] PASS");
  process.exit(0);
} else {
  console.error(`[smoke] FAIL: ${result.error ?? "unknown"}`);
  process.exit(1);
}
