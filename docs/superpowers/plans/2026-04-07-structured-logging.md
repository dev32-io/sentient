# Structured Logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured logging with persistent files, per-unit tags, millisecond timestamps, log sanitizer, and environment-aware log levels to the gateway.

**Architecture:** LogTape as the logging library (zero deps, Bun-native, built-in file rotation). A custom formatter produces `{iso-ms} {LEVEL} [{tag}] {event} | {kv pairs}` lines. A sanitizer sink wrapper scrubs sensitive data before any output. Log level controlled by `LOG_LEVEL` env (default: `debug`; Docker: `info`).

**Tech Stack:** `@logtape/logtape`, `@logtape/file`, Bun, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-07-structured-logging-design.md`
**Rules:** `gateway/.claude/rules/logging.md` | `agents/docs/logging-details.md`

---

## Task 1: Install Dependencies

**Files:**
- Modify: `gateway/package.json`

- [ ] **Step 1: Install LogTape packages**

```bash
cd gateway && bun add @logtape/logtape @logtape/file
```

- [ ] **Step 2: Verify installation**

```bash
cd gateway && bun run typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add gateway/package.json bun.lockb
git commit -m "chore(gateway): add @logtape/logtape and @logtape/file dependencies"
```

---

## Task 2: Log Formatter

**Files:**
- Create: `gateway/src/logging/format.ts`
- Create: `gateway/src/logging/format.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/logging/format.test.ts
import { describe, expect, it } from "vitest";
import { formatLogEntry, formatTag, serializeProperties } from "./format.ts";

describe("formatTag", () => {
  it("joins category parts with colon, skipping root", () => {
    expect(formatTag(["sentient", "tts", "fish-audio"])).toBe("tts:fish-audio");
  });

  it("returns root name when category has one element", () => {
    expect(formatTag(["sentient"])).toBe("sentient");
  });

  it("handles two-level category", () => {
    expect(formatTag(["sentient", "session"])).toBe("session");
  });
});

describe("serializeProperties", () => {
  it("serializes string values with quotes", () => {
    expect(serializeProperties({ text: "hello" })).toBe('text="hello"');
  });

  it("serializes number values without quotes", () => {
    expect(serializeProperties({ bytes: 960 })).toBe("bytes=960");
  });

  it("serializes boolean values", () => {
    expect(serializeProperties({ connected: true })).toBe("connected=true");
  });

  it("handles multiple properties", () => {
    const result = serializeProperties({ a: "x", b: 1 });
    expect(result).toBe('a="x" b=1');
  });

  it("returns empty string for empty object", () => {
    expect(serializeProperties({})).toBe("");
  });

  it("truncates long strings to 200 chars", () => {
    const long = "a".repeat(300);
    const result = serializeProperties({ text: long });
    expect(result).toContain("...[truncated]");
    expect(result.length).toBeLessThan(250);
  });
});

describe("formatLogEntry", () => {
  it("produces the expected format", () => {
    const result = formatLogEntry({
      level: "debug",
      category: ["sentient", "tts", "fish-audio"],
      message: "text-event-sent",
      timestamp: new Date("2026-04-07T20:34:12.847Z"),
      properties: { utteranceId: "utt-1712", bytes: 960 },
    });
    expect(result).toBe(
      '2026-04-07T20:34:12.847Z DEBUG [tts:fish-audio] text-event-sent | utteranceId="utt-1712" bytes=960',
    );
  });

  it("pads log level to 5 chars", () => {
    const result = formatLogEntry({
      level: "info",
      category: ["sentient"],
      message: "started",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      properties: {},
    });
    expect(result).toContain("INFO ");
  });

  it("omits pipe separator when no properties", () => {
    const result = formatLogEntry({
      level: "warn",
      category: ["sentient", "auth"],
      message: "no-key",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      properties: {},
    });
    expect(result).not.toContain("|");
    expect(result).toContain("[auth] no-key");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source scripts/env.sh && cd gateway && bun run vitest run src/logging/format.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement formatter**

```typescript
// gateway/src/logging/format.ts

const LEVEL_PAD: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warning: "WARN ",
  error: "ERROR",
  fatal: "FATAL",
};

const MAX_STRING_LENGTH = 200;

export function formatTag(category: readonly string[]): string {
  if (category.length <= 1) return category[0] ?? "unknown";
  return category.slice(1).join(":");
}

export function serializeProperties(props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const display = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value;
      parts.push(`${key}="${display}"`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(" ");
}

export interface LogEntryInput {
  level: string;
  category: readonly string[];
  message: string;
  timestamp: Date;
  properties: Record<string, unknown>;
}

export function formatLogEntry(entry: LogEntryInput): string {
  const ts = entry.timestamp.toISOString();
  const level = LEVEL_PAD[entry.level] ?? entry.level.toUpperCase().padEnd(5);
  const tag = formatTag(entry.category);
  const props = serializeProperties(entry.properties);
  const suffix = props ? ` | ${props}` : "";
  return `${ts} ${level} [${tag}] ${entry.message}${suffix}`;
}
```

- [ ] **Step 4: Run tests**

Run: `source scripts/env.sh && cd gateway && bun run vitest run src/logging/format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/logging/format.ts gateway/src/logging/format.test.ts
git commit -m "feat(logging): add structured log formatter — iso-ms timestamps, level, tag, kv props"
```

---

## Task 3: Log Sanitizer

**Files:**
- Create: `gateway/src/logging/log-sanitizer.ts`
- Create: `gateway/src/logging/log-sanitizer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/src/logging/log-sanitizer.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeValue, sanitizeMessage } from "./log-sanitizer.ts";

describe("sanitizeValue — key-based scrubbing", () => {
  it("redacts token keys", () => {
    expect(sanitizeValue("token", "v4.local.abc123xyz")).toBe("[REDACTED]");
  });

  it("redacts apiKey keys", () => {
    expect(sanitizeValue("apiKey", "sk-abc123")).toBe("[REDACTED]");
  });

  it("redacts api_key keys", () => {
    expect(sanitizeValue("api_key", "sk-abc123")).toBe("[REDACTED]");
  });

  it("redacts authorization keys", () => {
    expect(sanitizeValue("authorization", "Bearer abc123")).toBe("[REDACTED]");
  });

  it("redacts secret keys", () => {
    expect(sanitizeValue("secret", "mysecret")).toBe("[REDACTED]");
  });

  it("redacts password keys", () => {
    expect(sanitizeValue("password", "pass123")).toBe("[REDACTED]");
  });

  it("redacts pin keys", () => {
    expect(sanitizeValue("pin", "123456")).toBe("[REDACTED]");
  });

  it("is case-insensitive", () => {
    expect(sanitizeValue("ApiKey", "sk-abc")).toBe("[REDACTED]");
    expect(sanitizeValue("TOKEN", "v4.local.x")).toBe("[REDACTED]");
  });

  it("passes through safe keys", () => {
    expect(sanitizeValue("sessionId", "sess-42")).toBe("sess-42");
    expect(sanitizeValue("text", "hello world")).toBe("hello world");
    expect(sanitizeValue("bytes", 960)).toBe(960);
  });
});

describe("sanitizeMessage — pattern-based scrubbing", () => {
  it("redacts PASETO tokens in text", () => {
    const input = 'token=v4.local.abc123def456ghi789 sessionId=sess-1';
    expect(sanitizeMessage(input)).toContain("[REDACTED]");
    expect(sanitizeMessage(input)).toContain("sessionId=sess-1");
  });

  it("redacts Bearer tokens in text", () => {
    const input = 'Authorization: Bearer sk-abc123def456';
    expect(sanitizeMessage(input)).toContain("[REDACTED]");
  });

  it("passes through normal text unchanged", () => {
    const input = "Hello world, this is a normal sentence.";
    expect(sanitizeMessage(input)).toBe(input);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source scripts/env.sh && cd gateway && bun run vitest run src/logging/log-sanitizer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement sanitizer**

```typescript
// gateway/src/logging/log-sanitizer.ts

const SENSITIVE_KEYS = new Set([
  "token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "authorization",
  "pin",
  "paseto",
]);

const PASETO_PATTERN = /v4\.local\.\S+/g;
const BEARER_PATTERN = /Bearer\s+\S+/gi;

const REDACTED = "[REDACTED]";

export function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return REDACTED;
  return value;
}

export function sanitizeMessage(message: string): string {
  let result = message;
  result = result.replace(PASETO_PATTERN, REDACTED);
  result = result.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  return result;
}

export function sanitizeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    sanitized[key] = sanitizeValue(key, value);
  }
  return sanitized;
}
```

- [ ] **Step 4: Run tests**

Run: `source scripts/env.sh && cd gateway && bun run vitest run src/logging/log-sanitizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/logging/log-sanitizer.ts gateway/src/logging/log-sanitizer.test.ts
git commit -m "feat(logging): add log sanitizer — key-based + pattern-based sensitive data scrubbing"
```

---

## Task 4: Logger Setup

**Files:**
- Create: `gateway/src/logging/logger.ts`
- Create: `gateway/src/logging/logger.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// gateway/src/logging/logger.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayLogger, getLog } from "./logger.ts";
import { resetLogger } from "@logtape/logtape";

afterEach(async () => {
  await resetLogger();
});

describe("createGatewayLogger", () => {
  it("creates a logger that does not throw", async () => {
    const captured: string[] = [];
    await createGatewayLogger({
      logLevel: "debug",
      enableFile: false,
      testSink: (line) => captured.push(line),
    });

    const log = getLog(["sentient", "test"]);
    log.info("hello", { key: "value" });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toContain("[test] hello");
    expect(captured[0]).toContain('key="value"');
  });

  it("sanitizes sensitive data in output", async () => {
    const captured: string[] = [];
    await createGatewayLogger({
      logLevel: "debug",
      enableFile: false,
      testSink: (line) => captured.push(line),
    });

    const log = getLog(["sentient", "auth"]);
    log.info("auth-check", { token: "v4.local.secret123", sessionId: "sess-1" });

    expect(captured[0]).toContain("[REDACTED]");
    expect(captured[0]).not.toContain("secret123");
    expect(captured[0]).toContain("sess-1");
  });

  it("respects log level filtering", async () => {
    const captured: string[] = [];
    await createGatewayLogger({
      logLevel: "info",
      enableFile: false,
      testSink: (line) => captured.push(line),
    });

    const log = getLog(["sentient", "test"]);
    log.debug("should-be-filtered");
    log.info("should-appear");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("should-appear");
  });
});
```

- [ ] **Step 2: Implement logger**

```typescript
// gateway/src/logging/logger.ts
import { configure, getLogger, type LogLevel, resetLogger } from "@logtape/logtape";
import { formatLogEntry } from "./format.ts";
import { sanitizeMessage, sanitizeProperties } from "./log-sanitizer.ts";

export { resetLogger } from "@logtape/logtape";

export type LogLevelName = "debug" | "info" | "warning" | "error" | "fatal";

export interface GatewayLoggerOptions {
  logLevel?: string;
  enableFile?: boolean;
  logDir?: string;
  testSink?: (line: string) => void;
}

function mapLogLevel(level: string): LogLevel {
  switch (level.toLowerCase()) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "debug";
  }
}

function createFormattedSink(write: (line: string) => void) {
  return (record: { level: string; category: readonly string[]; message: readonly (string | unknown)[]; timestamp: number; properties: Record<string, unknown> }) => {
    const rawMessage = record.message
      .map((part) => (typeof part === "string" ? part : String(part)))
      .join("");
    const sanitizedProps = sanitizeProperties(record.properties);
    const sanitizedMsg = sanitizeMessage(rawMessage);
    const line = formatLogEntry({
      level: record.level,
      category: record.category,
      message: sanitizedMsg,
      timestamp: new Date(record.timestamp),
      properties: sanitizedProps,
    });
    write(line);
  };
}

export async function createGatewayLogger(options: GatewayLoggerOptions = {}): Promise<void> {
  const level = mapLogLevel(options.logLevel ?? process.env.LOG_LEVEL ?? "debug");
  const enableFile = options.enableFile ?? false;

  const sinks: Record<string, (record: unknown) => void> = {};

  if (options.testSink) {
    sinks.test = createFormattedSink(options.testSink) as (record: unknown) => void;
  } else {
    sinks.console = createFormattedSink((line) => process.stderr.write(`${line}\n`)) as (record: unknown) => void;
  }

  if (enableFile) {
    const { getFileSink } = await import("@logtape/file");
    const logDir = options.logDir ?? "logs";
    sinks.file = getFileSink(`${logDir}/{date}.log`) as unknown as (record: unknown) => void;
  }

  const loggers = options.testSink
    ? [{ sinkId: "test", level }]
    : enableFile
      ? [{ sinkId: "console", level }, { sinkId: "file", level }]
      : [{ sinkId: "console", level }];

  await configure({
    sinks,
    loggers: [
      {
        category: ["sentient"],
        lowestLevel: level,
        sinks: loggers.map((l) => l.sinkId),
      },
    ],
  });
}

export function getLog(category: string[]): {
  debug: (message: string, properties?: Record<string, unknown>) => void;
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn: (message: string, properties?: Record<string, unknown>) => void;
  error: (message: string, properties?: Record<string, unknown>) => void;
} {
  const logger = getLogger(category);
  return {
    debug: (msg, props = {}) => logger.debug`${msg} ${props}`,
    info: (msg, props = {}) => logger.info`${msg} ${props}`,
    warn: (msg, props = {}) => logger.warn`${msg} ${props}`,
    error: (msg, props = {}) => logger.error`${msg} ${props}`,
  };
}
```

**Note to implementer:** The LogTape API uses tagged template literals for structured logging. The `getLog` wrapper provides a simpler `(message, properties)` interface used throughout the codebase. Read LogTape docs at https://logtape.org/ for the exact sink/configure API — the code above is a starting scaffold. Adapt as needed to match LogTape's actual API for sinks (the sink function signature may differ). The important contract is:
- `createGatewayLogger()` configures LogTape with console + optional file sinks
- `getLog(category)` returns a logger with `.debug()/.info()/.warn()/.error()` methods
- All output passes through the formatter and sanitizer before writing
- Log level filtering works per the `LOG_LEVEL` env var
- `testSink` option captures output for testing

- [ ] **Step 3: Run tests**

Run: `source scripts/env.sh && cd gateway && bun run vitest run src/logging/logger.test.ts`
Expected: PASS (adapt implementation to make tests pass)

- [ ] **Step 4: Commit**

```bash
git add gateway/src/logging/logger.ts gateway/src/logging/logger.test.ts
git commit -m "feat(logging): add gateway logger setup — LogTape with formatter, sanitizer, file rotation"
```

---

## Task 5: Add `logs/` to Gitignore + Dockerfile ENV

**Files:**
- Modify: `.gitignore` (root)
- Modify: `gateway/Dockerfile`

- [ ] **Step 1: Add logs to gitignore**

Add to the end of the root `.gitignore`:

```
# Logs
logs/
*.log
```

- [ ] **Step 2: Update Dockerfile with LOG_LEVEL default**

In `gateway/Dockerfile`, add `ENV` directive before `CMD`:

```dockerfile
# Stage 2: Runtime
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/gateway/dist ./dist
ENV LOG_LEVEL=info
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1
CMD ["bun", "dist/index.js"]
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore gateway/Dockerfile
git commit -m "chore: add logs/ to gitignore, set LOG_LEVEL=info default in Docker"
```

---

## Task 6: Replace console.* in index.ts + Initialize Logger

**Files:**
- Modify: `gateway/src/index.ts`

- [ ] **Step 1: Add logger initialization and replace console calls**

At the top of `gateway/src/index.ts`, after imports, add:

```typescript
import { createGatewayLogger, getLog } from "./logging/logger.ts";

await createGatewayLogger({
  logLevel: process.env.LOG_LEVEL,
  enableFile: true,
  logDir: process.env.LOG_DIR ?? "logs",
});

const log = getLog(["sentient"]);
```

Replace all `console.info(...)` / `console.warn(...)` calls:

```typescript
// Replace:
console.warn("Could not load persona.md, using default persona");
// With:
log.warn("persona-fallback", { reason: "Could not load persona.md" });

// Replace:
console.info(`STT config: language=${STT_LANGUAGE}, sampleRate=48000, endpointing=${STT_DEFAULTS.endpointingMs}ms`);
// With:
log.info("stt-config", { language: STT_LANGUAGE, sampleRate: 48000, endpointingMs: STT_DEFAULTS.endpointingMs });

// Replace:
console.info(`Gateway listening on ${server.hostname}:${server.port}`);
// With:
log.info("gateway-started", { host: server.hostname, port: server.port });

// Replace all console.warn for missing keys:
// With:
if (!OPENROUTER_API_KEY) log.warn("missing-api-key", { key: "OPENROUTER_API_KEY", effect: "LLM disabled" });
if (!DEEPGRAM_API_KEY) log.warn("missing-api-key", { key: "DEEPGRAM_API_KEY", effect: "STT disabled" });
if (!FISH_AUDIO_API_KEY) log.warn("missing-api-key", { key: "FISH_AUDIO_API_KEY", effect: "TTS disabled" });
if (!FISH_AUDIO_VOICE_ID) log.warn("missing-api-key", { key: "FISH_AUDIO_VOICE_ID", effect: "TTS disabled" });
```

- [ ] **Step 2: Run typecheck**

Run: `source scripts/env.sh && cd gateway && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add gateway/src/index.ts
git commit -m "feat(logging): initialize structured logger in gateway entry, replace all console.* calls"
```

---

## Task 7: Add Logging to Pipeline Files

**Files:**
- Modify: `gateway/src/pipeline/voice-turn.ts`
- Modify: `gateway/src/pipeline/processors/streaming-overlap.ts`
- Modify: `gateway/src/pipeline/processors/tts-text-sanitizer.ts`
- Modify: `gateway/src/pipeline/processors/sentence-aggregator.ts`
- Modify: `gateway/src/pipeline/continuous-session.ts`

For each file: import `getLog`, create a tagged logger, add debug/info calls at key points per the spec.

- [ ] **Step 1: Add logging to voice-turn.ts**

```typescript
import { getLog } from "./logging/logger.ts"; // adjust path

const log = getLog(["sentient", "pipeline"]);

// At turn start:
log.info("turn-start", { transcript, model: chatModel });

// At each text event:
log.debug("text-event", { display: event.display, length: event.display.length });

// At each audio event:
log.debug("audio-event", { bytes: event.frame.data.length });

// At turn end:
log.info("turn-end", { textLength: fullText.length, audioStartEmitted, durationMs: Date.now() - startTime });
```

- [ ] **Step 2: Add logging to streaming-overlap.ts**

```typescript
const log = getLog(["sentient", "pipeline", "overlap"]);

// Sentence sent to TTS:
log.debug("sentence-to-tts", { sentence, length: sentence.length });

// Audio frame yielded:
log.debug("audio-frame", { bytes: frame.data.length });

// Text event yielded:
log.debug("text-event", { display });

// endTurn called:
log.info("end-turn");
```

- [ ] **Step 3: Add logging to tts-text-sanitizer.ts**

```typescript
const log = getLog(["sentient", "pipeline", "sanitizer"]);

// In sanitizeTransform:
log.debug("chunk-processed", { display: chunk.display, speechIn: chunk.speech, speechOut: sanitized });
```

- [ ] **Step 4: Add logging to sentence-aggregator.ts**

```typescript
const log = getLog(["sentient", "pipeline", "aggregator"]);

// In addToken:
log.debug("add-token", { tokenLength: token.length, bufferLength: buffer.length });

// In enqueue:
log.debug("sentence-detected", { sentence: trimmed });

// In doFlush:
log.debug("flush", { remaining: trimmed, queueSize: queue.pending.length });
```

- [ ] **Step 5: Add logging to continuous-session.ts**

```typescript
const log = getLog(["sentient", "session"]);

// State changes:
log.debug("assistant-speaking-changed", { from: prev, to: speaking });
log.debug("echo-cooldown-start", { durationMs: ECHO_COOLDOWN_MS });
log.debug("echo-cooldown-end");

// Barge-in:
log.info("barge-in", { text: event.text, confidence: event.confidence });

// Connect:
log.info("session-connect-start");
log.info("session-connected", { sttConnected: true, ttsConnected: true });

// Transcript events:
log.debug("transcript", { text: event.text, isFinal: event.isFinal, speechFinal: event.speechFinal, confidence: event.confidence });

// Speech events:
log.debug("speech-start");
log.debug("speech-end", { text: fullText });
```

- [ ] **Step 6: Run tests**

Run: `source scripts/env.sh && cd gateway && bun run vitest run`
Expected: PASS (logging calls are side effects, should not break tests)

- [ ] **Step 7: Commit**

```bash
git add gateway/src/pipeline/
git commit -m "feat(logging): add structured logging to pipeline — voice-turn, overlap, sanitizer, aggregator, session"
```

---

## Task 8: Add Logging to Providers

**Files:**
- Modify: `gateway/src/providers/tts/fish-audio-provider.ts`
- Modify: `gateway/src/providers/stt/deepgram-provider.ts`
- Modify: `gateway/src/providers/openrouter.ts`

- [ ] **Step 1: Add logging to fish-audio-provider.ts**

```typescript
const log = getLog(["sentient", "tts", "fish-audio"]);

// WS open:
log.info("ws-opened", { url: FISH_AUDIO_URL });
log.debug("start-sent", { voiceId: config.voiceId, format: config.format });

// Text event:
log.debug("text-event-sent", { text, queueSize: queue?.size() ?? 0 });

// Audio chunk received:
log.debug("audio-chunk-received", { bytes: parsed.audio.length, encoding: config.format, queueSize: queue?.size() ?? 0 });

// Finish:
log.debug("finish-received", { queueSize: queue?.size() ?? 0 });

// Stop sent:
log.debug("stop-sent");

// WS close:
log.info("ws-closed");

// Errors:
log.error("ws-error", { message: msg });
log.error("connect-timeout", { timeoutMs: config.connectTimeoutMs });
```

- [ ] **Step 2: Add logging to deepgram-provider.ts**

```typescript
const log = getLog(["sentient", "stt"]);
const transcriptLog = getLog(["sentient", "stt", "transcript"]);

// WS open/close:
log.info("ws-opened", { url: "deepgram" });
log.info("ws-closed");

// Every transcript:
transcriptLog.debug("transcript", { text: event.text, confidence: event.confidence, isFinal: event.isFinal, speechFinal: event.speechFinal });

// Keepalive:
log.debug("keepalive-sent");
```

- [ ] **Step 3: Add logging to openrouter.ts**

```typescript
const log = getLog(["sentient", "llm"]);

// Stream start:
log.info("stream-start", { model: options.model, messageCount: options.messages.length });

// Token received (high-frequency, debug only):
log.debug("token", { length: content.length, accumulated: tokenCount });

// Stream end:
log.info("stream-end", { totalTokens: tokenCount, durationMs: Date.now() - startTime });
```

- [ ] **Step 4: Run tests**

Run: `source scripts/env.sh && cd gateway && bun run vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/providers/
git commit -m "feat(logging): add structured logging to providers — fish-audio, deepgram, openrouter"
```

---

## Task 9: Add Logging to Server

**Files:**
- Modify: `gateway/src/server/ws-server.ts`
- Modify: `gateway/src/server/continuous-voice-handler.ts`

- [ ] **Step 1: Add logging to ws-server.ts**

```typescript
const log = getLog(["sentient", "ws"]);

// Client connect:
log.info("client-connected", { ip: ws.remoteAddress });

// Client disconnect:
log.info("client-disconnected", { reason });

// Auth success/failure:
log.info("auth-success", { sessionId });
log.warn("auth-failed", { reason });

// Replace any console.debug with log.debug
```

- [ ] **Step 2: Add logging to continuous-voice-handler.ts**

```typescript
const log = getLog(["sentient", "ws", "handler"]);

// Turn start:
log.info("turn-start", { responseId, transcript });

// Message dispatch:
log.debug("dispatch", { type: event.type, responseId });

// Binary frame sent:
log.debug("binary-sent", { bytes: (event.payload as Uint8Array).length });

// Barge-in:
log.info("barge-in-ack", { transcript });

// Turn end:
log.info("turn-end", { responseId });

// Errors:
log.error("turn-error", { responseId, message: errorMessage(error, "Voice turn failed") });
```

- [ ] **Step 3: Run tests**

Run: `source scripts/env.sh && cd gateway && bun run vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add gateway/src/server/
git commit -m "feat(logging): add structured logging to ws-server and voice handler"
```

---

## Task 10: Integration Test

- [ ] **Step 1: Run full CI**

```bash
source scripts/env.sh && bun run ci
```

Expected: lint + typecheck + tests all pass (same pre-existing failures only)

- [ ] **Step 2: Manual verification — check log output**

Start the gateway in dev mode:
```bash
source scripts/env.sh && cd gateway && LOG_LEVEL=debug bun run dev
```

- Verify `logs/` directory is created
- Verify `logs/2026-04-07.log` (or current date) file is created
- Verify log entries have correct format: `{iso-ms} {LEVEL} [{tag}] {event} | {kv}`
- Verify sensitive data (API keys from env) are not in the log file
- Send a test message and verify pipeline logging appears

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix(logging): integration fixes from smoke test"
```
