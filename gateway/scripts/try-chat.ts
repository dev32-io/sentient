#!/usr/bin/env bun
/**
 * Interactive text chat client for local gateway testing.
 *
 * Usage:
 *   Terminal 1: OPENROUTER_API_KEY="sk-or-..." bun run dev
 *   Terminal 2: bun run try
 *
 * Web auth has been dropped for now — the gateway accepts every WebSocket
 * connection and returns an anonymous session on open. See docs for the
 * future role-based login plan.
 */
import { createInterface } from "node:readline";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "ws://localhost:3000/ws";

console.info("\n  Sentient — Local Text Chat\n");
console.info(`  Connecting to ${GATEWAY_URL}...\n`);

const ws = new WebSocket(GATEWAY_URL);

const rl = createInterface({ input: process.stdin, output: process.stdout });

function prompt() {
  rl.question("\x1b[36myou:\x1b[0m ", (text) => {
    if (!text.trim()) {
      prompt();
      return;
    }
    if (text.trim() === "/quit") {
      // Just disconnect. There is no `session.end` frame — a client that is
      // done closes its socket, and the gateway derives liveness from attached
      // connections plus in-flight work (runtime/session-retention.ts).
      console.info("\n  Disconnecting. Bye!\n");
      ws.close();
      rl.close();
      process.exit(0);
    }
    if (text.trim() === "/ping") {
      ws.send(JSON.stringify({ type: "ping" }));
      return;
    }
    ws.send(JSON.stringify({ type: "text.input", text: text.trim() }));
  });
}

let isStreaming = false;

ws.onopen = () => {
  console.info("  Connected. Waiting for session...\n");
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data as string);

  switch (msg.type) {
    case "auth.ok":
      console.info(`  Session \x1b[32m${msg.sessionId}\x1b[0m (role: ${msg.role})\n`);
      console.info("  Type a message and press Enter. Commands: /quit, /ping\n");
      prompt();
      break;

    case "turn.text.delta":
      if (!isStreaming) {
        process.stdout.write("\x1b[33msentient:\x1b[0m ");
        isStreaming = true;
      }
      process.stdout.write(msg.text);
      break;

    case "turn.completed":
      process.stdout.write("\n\n");
      isStreaming = false;
      prompt();
      break;

    case "turn.aborted":
      process.stdout.write(`\n  \x1b[31m[cut off: ${msg.cutoff}]\x1b[0m\n\n`);
      isStreaming = false;
      prompt();
      break;

    case "turn.tool.update":
      console.info(`  \x1b[35m[tool]\x1b[0m ${msg.toolName} ${msg.status}`);
      break;

    case "pong":
      console.info("  pong!\n");
      prompt();
      break;

    case "error":
      console.error(`\n  \x1b[31merror [${msg.code}]:\x1b[0m ${msg.message}\n`);
      prompt();
      break;

    default:
      console.info(`  [${msg.type}]`, JSON.stringify(msg));
      break;
  }
};

ws.onerror = () => {
  console.error("\n  \x1b[31mCould not connect.\x1b[0m Is the gateway running?\n");
  console.error("  Start it with:");
  console.error('  OPENROUTER_API_KEY="..." bun run dev\n');
  process.exit(1);
};

ws.onclose = () => {
  if (!isStreaming) {
    console.info("\n  Connection closed.\n");
    rl.close();
    process.exit(0);
  }
};
