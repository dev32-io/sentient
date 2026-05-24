# Phase 1.2 — Wire-Protocol Parity (live HermesClient)

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Previous:** `2026-04-21-hermes-phase1.1-scaffolding.md` (must be complete)

**Goal:** a real `HermesClient.dispatch()` that consumes SSE from a live Hermes container and emits `HermesEvent`s. An event translator that produces EXISTING wire messages (`cycle.*`, `message.*`, `task.*`, `conversation.entry`). Contract tests against a real Hermes image. No live gateway cutover yet — the new code path is reachable only behind `cerebrum.provider: "hermes"`.

**Builds on:** Phase 1.1 (skeleton `HermesClient`, `HermesEvent` types, `ConversationMirror`, `TaskMirror`, `SessionRouter`).

**Spec reference:** v4 §5.2, §5.3, §5.9, §6, Appendix A.

---

## 1. Context and prerequisites

### What we build

| Component | Role |
|---|---|
| `HttpHermesClient.dispatch()` | Real implementation. Fetches `POST /v1/responses` with SSE, parses events, emits typed `HermesEvent`s. Respects `AbortSignal`. |
| `HermesEventTranslator` | Converts `HermesEvent` stream into existing wire messages. Deterministic mapping per Appendix A. |
| `ConversationMirror` + `TaskMirror` wiring | Translator mutates these as it emits wire messages. |
| `hermes-dispatcher.ts` | Thin function `AttentionGate` calls. Owns client instantiation, stream translation, conversationId capture. |
| Integration test | Assumes the dev `hermes-alice` container from Phase 1.1 is running. Fires representative turns, asserts the event stream. |

### What we do NOT build in 1.2

- TTS decorator pipeline integration — Phase 1.3.
- Gateway-hosted MCP tools — Phase 1.4.
- HA MCP wiring — Phase 1.5.
- DDG MCP wiring — Phase 1.6.
- Multi-user SessionRouter — Phase 1.7.

The `cerebrum.provider` flag stays `in-process` at end of Phase 1.2. Flip happens in Phase 1.7.

### SSE event shape reminders (from Phase 1.0 M-3)

From Phase 1.0 `notes/2026-04-21-phase1.0-measurements.md`:

- Every run emits: `response.created`, `response.output_item.added`, `response.output_text.delta` (per text chunk), `response.output_item.done`, `response.completed`.
- Function calls emit: `response.output_item.added { type: "function_call" }`, optionally `response.function_call_arguments.delta` (if M-3 PRESENT), `response.output_item.done`.
- Read your M-3 verdict to decide whether to handle `function_call_arguments.delta`. If ABSENT, skip the corresponding translator case.

### Keep-alive / abort semantics

- **Keep-alive:** reuse HTTP connection per Hermes profile. Bun's `fetch` does this automatically.
- **Abort:** when `AbortSignal` fires, the SSE reader MUST exit the loop, close the stream, and NOT throw. Implementation: pass signal to `fetch()`, and check `signal.aborted` between reads.

---

## Task 1.2.1 — Real SSE consumer in `HermesClient`

**Files:**
- Modify: `gateway/src/cerebrum/hermes-client.ts`
- Modify: `gateway/src/cerebrum/hermes-client.test.ts` (unit tests with mocked fetch)
- Create: `gateway/src/cerebrum/sse-parser.ts`
- Create: `gateway/src/cerebrum/sse-parser.test.ts`

### Step 1.2.1a: SSE parser unit

Standard SSE: lines split by `\n`, events delimited by blank lines. Small, tested parser so `HermesClient` is pure stream-transform over it.

- [ ] Create `gateway/src/cerebrum/sse-parser.ts`:

```typescript
import { createLogger } from "@sentient/logging";

const log = createLogger(["sentient.gateway.cerebrum", "sse-parser"]);

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Parse a ReadableStream of raw bytes into SseEvents.
 * Respects AbortSignal — stops yielding, releases reader, does NOT throw.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let bytesSeen = 0;

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesSeen += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseSseBlock(rawEvent);
        if (evt) yield evt;
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      log.debug("parseSseStream.error", { err: String(err), bytesSeen });
      throw err;
    }
    log.debug("parseSseStream.aborted", { bytesSeen });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split("\n");
  const dataLines: string[] = [];
  let eventName: string | undefined;
  let id: string | undefined;
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
      default:
        break;
    }
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join("\n"), id };
}
```

### Step 1.2.1b: SSE parser tests

- [ ] Create `gateway/src/cerebrum/sse-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseSseStream } from "./sse-parser";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("parseSseStream", () => {
  it("parses a single event", async () => {
    const s = streamFromChunks(["data: hello\n\n"]);
    const events = await collect(parseSseStream(s, new AbortController().signal));
    expect(events).toEqual([{ event: undefined, data: "hello", id: undefined }]);
  });

  it("parses named event with id", async () => {
    const s = streamFromChunks(["event: foo\nid: 42\ndata: payload\n\n"]);
    const events = await collect(parseSseStream(s, new AbortController().signal));
    expect(events[0]).toEqual({ event: "foo", data: "payload", id: "42" });
  });

  it("joins multi-line data with \\n", async () => {
    const s = streamFromChunks(["data: line1\ndata: line2\n\n"]);
    const events = await collect(parseSseStream(s, new AbortController().signal));
    expect(events[0]?.data).toBe("line1\nline2");
  });

  it("handles chunk boundaries mid-event", async () => {
    const s = streamFromChunks(["data: hel", "lo\n\ndata: world\n\n"]);
    const events = await collect(parseSseStream(s, new AbortController().signal));
    expect(events.map((e) => e.data)).toEqual(["hello", "world"]);
  });

  it("skips comment lines starting with :", async () => {
    const s = streamFromChunks([": keep-alive\n\ndata: value\n\n"]);
    const events = await collect(parseSseStream(s, new AbortController().signal));
    expect(events[0]?.data).toBe("value");
  });

  it("stops on abort", async () => {
    const ctrl = new AbortController();
    const s = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
    });
    const it = parseSseStream(s, ctrl.signal);
    const { value: first } = await it.next();
    expect(first?.data).toBe("first");
    ctrl.abort();
    const { done } = await it.next();
    expect(done).toBe(true);
  });
});
```

- [ ] Verify:

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- sse-parser
```

### Step 1.2.1c: Implement real `HttpHermesClient.dispatch()`

- [ ] Replace `gateway/src/cerebrum/hermes-client.ts` contents:

```typescript
import { createLogger } from "@sentient/logging";
import { z } from "zod";
import { parseSseStream } from "./sse-parser";
import type {
  DispatchMode,
  HermesEvent,
  HermesTurnInput,
} from "./hermes-event-types";

const log = createLogger(["sentient.gateway.cerebrum", "hermes-client"]);

export interface HermesProfileBinding {
  userId: string;
  url: string;
  apiKey: string;
  conversationId: string | null;
}

export interface HermesClient {
  dispatch(
    input: HermesTurnInput,
    signal: AbortSignal,
    mode: DispatchMode,
  ): AsyncGenerator<HermesEvent>;
}

// Zod schemas for raw SSE payloads. Permissive: unknown fields ignored; unknown
// event types logged and skipped.
const sseCreatedSchema = z.object({
  type: z.literal("response.created"),
  response: z.object({
    id: z.string(),
    conversation: z.string().optional(),
  }),
});

const sseTextDeltaSchema = z.object({
  type: z.literal("response.output_text.delta"),
  delta: z.string(),
});

const sseItemAddedFunctionCallSchema = z.object({
  type: z.literal("response.output_item.added"),
  item: z.object({
    id: z.string(),
    type: z.literal("function_call"),
    name: z.string(),
    arguments: z.string().optional().default(""),
  }),
});

const sseItemAddedMessageSchema = z.object({
  type: z.literal("response.output_item.added"),
  item: z.object({
    id: z.string(),
    type: z.literal("message"),
  }),
});

const sseArgsDeltaSchema = z.object({
  type: z.literal("response.function_call_arguments.delta"),
  item_id: z.string(),
  delta: z.string(),
});

const sseItemDoneSchema = z.object({
  type: z.literal("response.output_item.done"),
  item: z.object({
    id: z.string(),
    type: z.string(),
    status: z.string().optional(),
  }),
});

const sseCompletedSchema = z.object({
  type: z.literal("response.completed"),
  response: z.object({
    id: z.string(),
    usage: z
      .object({
        input_tokens: z.number().int(),
        output_tokens: z.number().int(),
      })
      .optional(),
  }),
});

const sseErrorSchema = z.object({
  type: z.literal("response.error"),
  error: z.object({
    message: z.string(),
  }),
});

interface InFlightCall {
  name: string;
  argsAccum: string;
}

export class HttpHermesClient implements HermesClient {
  constructor(private readonly binding: HermesProfileBinding) {
    log.debug("construct", { userId: binding.userId, url: binding.url });
  }

  async *dispatch(
    input: HermesTurnInput,
    signal: AbortSignal,
    mode: DispatchMode,
  ): AsyncGenerator<HermesEvent> {
    const url = `${this.binding.url}/v1/responses`;
    const body = {
      model: "google/gemini-2.5-flash",
      input: input.userMessage,
      conversation: input.conversationId ?? undefined,
      stream: true,
      max_output_tokens: input.maxOutputTokens,
    };

    log.debug("dispatch.start", {
      userId: input.userId,
      cycleId: input.cycleId,
      conversationId: input.conversationId,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.binding.apiKey}`,
          "Idempotency-Key": input.cycleId,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        log.debug("dispatch.aborted.before-response", { cycleId: input.cycleId });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.debug("dispatch.fetch.error", { cycleId: input.cycleId, err: message });
      yield { type: "error", message: `hermes fetch error: ${message}` };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await safeReadText(res);
      log.debug("dispatch.http.error", {
        cycleId: input.cycleId,
        status: res.status,
        body: text.slice(0, 500),
      });
      yield { type: "error", message: `hermes http ${res.status}: ${text.slice(0, 200)}` };
      return;
    }

    const inFlight = new Map<string, InFlightCall>();

    for await (const sse of parseSseStream(res.body, signal)) {
      if (signal.aborted) {
        log.debug("dispatch.aborted.during-stream", { cycleId: input.cycleId });
        return;
      }
      const parsed = safeJson(sse.data);
      if (!parsed) continue;

      for (const ev of translateSse(parsed, inFlight, mode)) {
        yield ev;
      }
    }

    log.debug("dispatch.stream.exhausted", { cycleId: input.cycleId });
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

function safeJson(data: string): unknown | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Pure: SSE JSON → HermesEvent[]. Kept standalone for testability.
 */
export function translateSse(
  raw: unknown,
  inFlight: Map<string, InFlightCall>,
  _mode: DispatchMode,
): HermesEvent[] {
  if (typeof raw !== "object" || raw === null) return [];
  const type = (raw as { type?: unknown }).type;

  if (type === "response.created") {
    const p = sseCreatedSchema.safeParse(raw);
    if (!p.success) return [];
    return [
      {
        type: "created",
        responseId: p.data.response.id,
        conversationId: p.data.response.conversation ?? "",
      },
    ];
  }

  if (type === "response.output_text.delta") {
    const p = sseTextDeltaSchema.safeParse(raw);
    if (!p.success) return [];
    return [{ type: "text.delta", delta: p.data.delta }];
  }

  if (type === "response.output_item.added") {
    const fn = sseItemAddedFunctionCallSchema.safeParse(raw);
    if (fn.success) {
      inFlight.set(fn.data.item.id, {
        name: fn.data.item.name,
        argsAccum: fn.data.item.arguments ?? "",
      });
      return [
        {
          type: "tool.started",
          callId: fn.data.item.id,
          toolName: fn.data.item.name,
          argsPreview: truncate(fn.data.item.arguments ?? "", 200),
        },
      ];
    }
    const msg = sseItemAddedMessageSchema.safeParse(raw);
    if (msg.success) return [];
    return [];
  }

  if (type === "response.function_call_arguments.delta") {
    const p = sseArgsDeltaSchema.safeParse(raw);
    if (!p.success) return [];
    const rec = inFlight.get(p.data.item_id);
    if (rec) rec.argsAccum += p.data.delta;
    return [{ type: "tool.args.delta", callId: p.data.item_id, delta: p.data.delta }];
  }

  if (type === "response.output_item.done") {
    const p = sseItemDoneSchema.safeParse(raw);
    if (!p.success) return [];
    if (p.data.item.type === "function_call") {
      const rec = inFlight.get(p.data.item.id);
      const status = p.data.item.status === "completed" ? "ok" : "failed";
      inFlight.delete(p.data.item.id);
      return [
        {
          type: "tool.finished",
          callId: p.data.item.id,
          status,
          summary: rec ? truncate(rec.argsAccum, 200) : "",
        },
      ];
    }
    return [];
  }

  if (type === "response.completed") {
    const p = sseCompletedSchema.safeParse(raw);
    if (!p.success) return [];
    const u = p.data.response.usage ?? { input_tokens: 0, output_tokens: 0 };
    return [
      {
        type: "completed",
        usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens },
      },
    ];
  }

  if (type === "response.error") {
    const p = sseErrorSchema.safeParse(raw);
    if (!p.success) return [];
    return [{ type: "error", message: p.data.error.message }];
  }

  log.debug("translateSse.skipped", { type: String(type) });
  return [];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
```

### Step 1.2.1d: Update HermesClient tests with mocked SSE

- [ ] Replace `gateway/src/cerebrum/hermes-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HttpHermesClient,
  translateSse,
  type HermesProfileBinding,
} from "./hermes-client";
import type { DispatchMode } from "./hermes-event-types";

const binding: HermesProfileBinding = {
  userId: "alice",
  url: "http://localhost:8643",
  apiKey: "test-key",
  conversationId: null,
};

const mode: DispatchMode = { bargedIn: () => false };

function sseResponseFromEvents(events: unknown[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("translateSse (pure)", () => {
  it("maps response.created to HermesEvent created", () => {
    const out = translateSse(
      { type: "response.created", response: { id: "resp_1", conversation: "conv_1" } },
      new Map(),
      mode,
    );
    expect(out).toEqual([
      { type: "created", responseId: "resp_1", conversationId: "conv_1" },
    ]);
  });

  it("maps text delta", () => {
    const out = translateSse(
      { type: "response.output_text.delta", delta: "hello" },
      new Map(),
      mode,
    );
    expect(out).toEqual([{ type: "text.delta", delta: "hello" }]);
  });

  it("maps function_call added → tool.started and remembers args", () => {
    const inFlight = new Map();
    const out = translateSse(
      {
        type: "response.output_item.added",
        item: { id: "call_1", type: "function_call", name: "search", arguments: "{}" },
      },
      inFlight,
      mode,
    );
    expect(out).toEqual([
      { type: "tool.started", callId: "call_1", toolName: "search", argsPreview: "{}" },
    ]);
    expect(inFlight.get("call_1")?.name).toBe("search");
  });

  it("maps function_call_arguments.delta into tool.args.delta and accumulates", () => {
    const inFlight = new Map();
    translateSse(
      {
        type: "response.output_item.added",
        item: { id: "c1", type: "function_call", name: "search", arguments: "" },
      },
      inFlight,
      mode,
    );
    const out = translateSse(
      { type: "response.function_call_arguments.delta", item_id: "c1", delta: '{"q":"hi"}' },
      inFlight,
      mode,
    );
    expect(out).toEqual([{ type: "tool.args.delta", callId: "c1", delta: '{"q":"hi"}' }]);
    expect(inFlight.get("c1")?.argsAccum).toBe('{"q":"hi"}');
  });

  it("maps output_item.done(function_call) → tool.finished", () => {
    const inFlight = new Map([["c1", { name: "search", argsAccum: "{}" }]]);
    const out = translateSse(
      {
        type: "response.output_item.done",
        item: { id: "c1", type: "function_call", status: "completed" },
      },
      inFlight,
      mode,
    );
    expect(out).toEqual([
      { type: "tool.finished", callId: "c1", status: "ok", summary: "{}" },
    ]);
    expect(inFlight.has("c1")).toBe(false);
  });

  it("ignores unknown event types", () => {
    const out = translateSse({ type: "response.weird" }, new Map(), mode);
    expect(out).toEqual([]);
  });

  it("tolerates malformed payload", () => {
    const out = translateSse({ type: "response.output_text.delta" }, new Map(), mode);
    expect(out).toEqual([]);
  });
});

describe("HttpHermesClient.dispatch (mocked fetch)", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("yields events from a mocked SSE stream", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponseFromEvents([
        { type: "response.created", response: { id: "r1", conversation: "c1" } },
        { type: "response.output_text.delta", delta: "hi " },
        { type: "response.output_text.delta", delta: "there" },
        {
          type: "response.completed",
          response: { id: "r1", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]),
    );

    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const events: unknown[] = [];
    for await (const e of client.dispatch(
      {
        userId: "alice",
        cycleId: "cycle-1",
        userMessage: "hi",
        conversationId: null,
        maxOutputTokens: 128,
      },
      ctrl.signal,
      mode,
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "created", responseId: "r1", conversationId: "c1" },
      { type: "text.delta", delta: "hi " },
      { type: "text.delta", delta: "there" },
      { type: "completed", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("emits error on non-2xx status", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    );
    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const events: unknown[] = [];
    for await (const e of client.dispatch(
      {
        userId: "alice",
        cycleId: "cycle-2",
        userMessage: "hi",
        conversationId: null,
        maxOutputTokens: 128,
      },
      ctrl.signal,
      mode,
    )) {
      events.push(e);
    }
    const first = events[0] as { type: string; message: string };
    expect(first.type).toBe("error");
    expect(first.message).toMatch(/401/);
  });

  it("stops yielding when signal aborts", async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllerRef = controller;
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(
                  'data: {"type":"response.created","response":{"id":"r1","conversation":"c1"}}\n\n',
                ),
              );
            },
          }),
        ),
    );
    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const gen = client.dispatch(
      {
        userId: "alice",
        cycleId: "cycle-3",
        userMessage: "hi",
        conversationId: null,
        maxOutputTokens: 128,
      },
      ctrl.signal,
      mode,
    );
    const first = await gen.next();
    expect(first.done).toBe(false);
    ctrl.abort();
    if (controllerRef) controllerRef.close();
    const done = await gen.next();
    expect(done.done).toBe(true);
  });
});
```

- [ ] Verify:

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- hermes-client
```

### Step 1.2.1e: Commit

```bash
git add gateway/src/cerebrum/sse-parser.ts gateway/src/cerebrum/sse-parser.test.ts gateway/src/cerebrum/hermes-client.ts gateway/src/cerebrum/hermes-client.test.ts
git commit -m "$(cat <<'EOF'
feat(cerebrum): live HermesClient SSE consumer + translator

Real POST /v1/responses with SSE. Parses OpenAI Responses-style events,
translates to typed HermesEvent. Respects AbortSignal — aborts fetch,
stops yielding, releases reader without throwing. Mocked-fetch tests
cover happy path, HTTP error, and mid-stream abort. Pure translateSse()
tested separately with table-driven cases per Appendix A.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.2.2 — `HermesEventTranslator` → wire messages

**Files:**
- Create: `gateway/src/cerebrum/hermes-event-translator.ts`
- Create: `gateway/src/cerebrum/hermes-event-translator.test.ts`

### Step 1.2.2a: Translator implementation

- [ ] Create `gateway/src/cerebrum/hermes-event-translator.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import type { HermesEvent } from "./hermes-event-types";
import type { ConversationMirror } from "./conversation-mirror";
import type { TaskMirror } from "./task-mirror";

const log = createLogger(["sentient.gateway.cerebrum", "hermes-translator"]);

export type WireEmitter = (message: Record<string, unknown>) => void;

export interface TranslatorContext {
  sessionId: string;
  cycleId: string;
  userId: string;
}

export async function translateHermesStream(
  events: AsyncIterable<HermesEvent>,
  context: TranslatorContext,
  mirror: ConversationMirror,
  tasks: TaskMirror,
  emit: WireEmitter,
  onConversationId: (id: string) => void,
): Promise<void> {
  const { cycleId, userId } = context;
  let assistantText = "";
  const effectsInvoked: string[] = [];
  let sawError = false;

  emit({
    type: "cycle.started",
    cycleId,
    triggerKind: "conversation.user",
    triggerSource: userId,
  });

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case "created": {
          onConversationId(ev.conversationId);
          log.debug("conversation-bound", { cycleId, conversationId: ev.conversationId });
          break;
        }
        case "text.delta": {
          assistantText += ev.delta;
          emit({ type: "message.delta", cycleId, delta: ev.delta });
          break;
        }
        case "tool.started": {
          effectsInvoked.push(ev.toolName);
          tasks.start({
            taskId: ev.callId,
            toolName: ev.toolName,
            cycleId,
            argsPreview: ev.argsPreview,
          });
          emit({
            type: "task.update",
            taskId: ev.callId,
            toolName: ev.toolName,
            cycleId,
            status: "running",
            argsPreview: ev.argsPreview,
            startedAtMs: Date.now(),
          });
          break;
        }
        case "tool.args.delta": {
          // argsPreview is updated in HermesClient's inFlight map; no wire emit
          break;
        }
        case "tool.finished": {
          const rec = tasks.finish(
            ev.callId,
            ev.status === "ok" ? "finished" : "failed",
          );
          if (rec) {
            emit({
              type: "task.update",
              taskId: rec.taskId,
              toolName: rec.toolName,
              cycleId,
              status: rec.status,
              argsPreview: rec.argsPreview,
              startedAtMs: rec.startedAtMs,
              endedAtMs: rec.endedAtMs,
            });
            mirror.append({
              kind: "tool",
              ts: rec.endedAtMs ?? Date.now(),
              toolName: rec.toolName,
              status: rec.status === "finished" ? "finished" : "failed",
              summary: ev.summary,
            });
            emit({
              type: "conversation.entry",
              item: {
                kind: "tool",
                ts: rec.endedAtMs ?? Date.now(),
                toolName: rec.toolName,
                status: rec.status === "finished" ? "finished" : "failed",
                summary: ev.summary,
              },
            });
          }
          break;
        }
        case "completed": {
          emit({ type: "message.done", cycleId });
          if (assistantText.length > 0) {
            const ts = Date.now();
            mirror.append({ kind: "assistant", ts, content: assistantText });
            emit({
              type: "conversation.entry",
              item: { kind: "assistant", ts, content: assistantText },
            });
          }
          emit({
            type: "cycle.completed",
            cycleId,
            effectsInvoked: Array.from(new Set(effectsInvoked)),
          });
          break;
        }
        case "error": {
          sawError = true;
          emit({ type: "error", code: "hermes", message: ev.message });
          break;
        }
      }
    }
  } catch (err) {
    sawError = true;
    const msg = err instanceof Error ? err.message : String(err);
    log.debug("translateHermesStream.error", { cycleId, err: msg });
    emit({ type: "error", code: "hermes_stream", message: msg });
  }

  if (sawError) {
    emit({ type: "cycle.aborted", cycleId, reason: "error" });
    if (assistantText.length > 0) {
      const ts = Date.now();
      mirror.append({
        kind: "assistant",
        ts,
        content: assistantText,
        cutoff: { kind: "interrupt", cancelledTaskIds: [] },
      });
      emit({
        type: "conversation.entry",
        item: {
          kind: "assistant",
          ts,
          content: assistantText,
          cutoff: { kind: "interrupt", cancelledTaskIds: [] },
        },
      });
    }
    tasks.clearCycle(cycleId);
  }

  log.debug("translateHermesStream.done", {
    cycleId,
    sawError,
    assistantChars: assistantText.length,
    effectsInvoked,
  });
}
```

### Step 1.2.2b: Translator tests

- [ ] Create `gateway/src/cerebrum/hermes-event-translator.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { translateHermesStream } from "./hermes-event-translator";
import { createConversationMirror } from "./conversation-mirror";
import { createTaskMirror } from "./task-mirror";
import type { HermesEvent } from "./hermes-event-types";

async function* events(list: HermesEvent[]): AsyncGenerator<HermesEvent> {
  for (const e of list) yield e;
}

function makeContext() {
  return { sessionId: "s1", cycleId: "c1", userId: "alice" };
}

describe("translateHermesStream", () => {
  it("emits cycle.started → message.delta × N → message.done + cycle.completed", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const stream = events([
      { type: "created", responseId: "r1", conversationId: "conv1" },
      { type: "text.delta", delta: "hi " },
      { type: "text.delta", delta: "there" },
      { type: "completed", usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    const onConv = vi.fn();
    await translateHermesStream(
      stream,
      makeContext(),
      mirror,
      tasks,
      (m) => emitted.push(m),
      onConv,
    );
    const types = emitted.map((m) => m.type);
    expect(types).toEqual([
      "cycle.started",
      "message.delta",
      "message.delta",
      "message.done",
      "conversation.entry",
      "cycle.completed",
    ]);
    expect(onConv).toHaveBeenCalledWith("conv1");
    expect(mirror.snapshot()).toHaveLength(1);
  });

  it("emits task.update running + finished for a tool call", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const stream = events([
      { type: "created", responseId: "r1", conversationId: "c" },
      { type: "tool.started", callId: "call_1", toolName: "search", argsPreview: "{}" },
      { type: "tool.finished", callId: "call_1", status: "ok", summary: "result" },
      { type: "completed", usage: { inputTokens: 1, outputTokens: 0 } },
    ]);
    await translateHermesStream(
      stream,
      makeContext(),
      mirror,
      tasks,
      (m) => emitted.push(m),
      () => {},
    );
    const taskEvents = emitted.filter((m) => m.type === "task.update");
    expect(taskEvents).toHaveLength(2);
    expect((taskEvents[0] as { status: string }).status).toBe("running");
    expect((taskEvents[1] as { status: string }).status).toBe("finished");
    const cycleCompleted = emitted.find((m) => m.type === "cycle.completed") as {
      effectsInvoked: string[];
    };
    expect(cycleCompleted.effectsInvoked).toContain("search");
  });

  it("on stream error, emits error + cycle.aborted and cutoff entry", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();

    async function* withError(): AsyncGenerator<HermesEvent> {
      yield { type: "created", responseId: "r1", conversationId: "c" };
      yield { type: "text.delta", delta: "partial" };
      yield { type: "error", message: "upstream blew up" };
    }

    await translateHermesStream(
      withError(),
      makeContext(),
      mirror,
      tasks,
      (m) => emitted.push(m),
      () => {},
    );

    const types = emitted.map((m) => m.type);
    expect(types).toContain("error");
    expect(types).toContain("cycle.aborted");
    const cutoffEntry = emitted.find(
      (m) => m.type === "conversation.entry",
    ) as { item: { cutoff?: { kind: string } } };
    expect(cutoffEntry.item.cutoff?.kind).toBe("interrupt");
  });
});
```

- [ ] Verify + commit:

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- hermes-event-translator
git add gateway/src/cerebrum/hermes-event-translator.ts gateway/src/cerebrum/hermes-event-translator.test.ts
git commit -m "$(cat <<'EOF'
feat(cerebrum): Hermes event → wire message translator

Pure async consumer of HermesEvent stream. Emits cycle.started,
message.delta, message.done, task.update, conversation.entry, and
cycle.completed/aborted per v4 spec §6 + Appendix A. Mutates
ConversationMirror + TaskMirror. Error paths commit partial assistant
text with cutoff:interrupt badge.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.2.3 — Dispatch shim for AttentionGate

**Files:**
- Create: `gateway/src/cerebrum/hermes-dispatcher.ts`
- Create: `gateway/src/cerebrum/hermes-dispatcher.test.ts`

### Step 1.2.3a: The shim

- [ ] Create `gateway/src/cerebrum/hermes-dispatcher.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import type { HermesClient, HermesProfileBinding } from "./hermes-client";
import { translateHermesStream, type WireEmitter } from "./hermes-event-translator";
import type { ConversationMirror } from "./conversation-mirror";
import type { TaskMirror } from "./task-mirror";
import type { DispatchMode } from "./hermes-event-types";

const log = createLogger(["sentient.gateway.cerebrum", "hermes-dispatcher"]);

export interface HermesDispatcherDeps {
  clientFor(binding: HermesProfileBinding): HermesClient;
  mirror: ConversationMirror;
  tasks: TaskMirror;
  emit: WireEmitter;
}

export interface HermesDispatchRequest {
  sessionId: string;
  userId: string;
  cycleId: string;
  userMessage: string;
  binding: HermesProfileBinding;
  maxOutputTokens: number;
  signal: AbortSignal;
  mode: DispatchMode;
}

export async function dispatchHermesCycle(
  req: HermesDispatchRequest,
  deps: HermesDispatcherDeps,
): Promise<{ conversationId: string | null }> {
  const client = deps.clientFor(req.binding);
  let capturedConversationId: string | null = req.binding.conversationId;

  log.debug("dispatch.begin", {
    sessionId: req.sessionId,
    userId: req.userId,
    cycleId: req.cycleId,
  });

  const events = client.dispatch(
    {
      userId: req.userId,
      cycleId: req.cycleId,
      userMessage: req.userMessage,
      conversationId: req.binding.conversationId,
      maxOutputTokens: req.maxOutputTokens,
    },
    req.signal,
    req.mode,
  );

  await translateHermesStream(
    events,
    { sessionId: req.sessionId, cycleId: req.cycleId, userId: req.userId },
    deps.mirror,
    deps.tasks,
    deps.emit,
    (id) => {
      capturedConversationId = id;
    },
  );

  log.debug("dispatch.end", {
    cycleId: req.cycleId,
    conversationId: capturedConversationId,
  });

  return { conversationId: capturedConversationId };
}
```

### Step 1.2.3b: Shim tests

- [ ] Create `gateway/src/cerebrum/hermes-dispatcher.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { dispatchHermesCycle } from "./hermes-dispatcher";
import { createConversationMirror } from "./conversation-mirror";
import { createTaskMirror } from "./task-mirror";
import type { HermesClient, HermesProfileBinding } from "./hermes-client";
import type { HermesEvent } from "./hermes-event-types";

describe("dispatchHermesCycle", () => {
  it("runs happy path, captures conversationId, returns it", async () => {
    const fakeClient: HermesClient = {
      async *dispatch() {
        const events: HermesEvent[] = [
          { type: "created", responseId: "r1", conversationId: "conv-new" },
          { type: "text.delta", delta: "hi" },
          { type: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
        ];
        for (const e of events) yield e;
      },
    };
    const emitted: Array<Record<string, unknown>> = [];
    const mirror = createConversationMirror();
    const tasks = createTaskMirror();
    const binding: HermesProfileBinding = {
      userId: "alice",
      url: "http://localhost",
      apiKey: "k",
      conversationId: null,
    };
    const ctrl = new AbortController();
    const out = await dispatchHermesCycle(
      {
        sessionId: "s1",
        userId: "alice",
        cycleId: "c1",
        userMessage: "hi",
        binding,
        maxOutputTokens: 32,
        signal: ctrl.signal,
        mode: { bargedIn: () => false },
      },
      {
        clientFor: () => fakeClient,
        mirror,
        tasks,
        emit: (m) => emitted.push(m),
      },
    );
    expect(out.conversationId).toBe("conv-new");
    expect(emitted.map((m) => m.type)).toContain("cycle.completed");
  });
});
```

### Step 1.2.3c: Verify + commit

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- hermes-dispatcher
git add gateway/src/cerebrum/hermes-dispatcher.ts gateway/src/cerebrum/hermes-dispatcher.test.ts
git commit -m "$(cat <<'EOF'
feat(cerebrum): hermes dispatch shim for AttentionGate wiring

Thin function AttentionGate will call when cerebrum.provider=hermes.
Owns client instantiation, stream translation, mirror updates, and
conversationId capture. Returns the captured id so SessionRouter can
persist it on binding for the next turn.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.2.4 — Manual integration test against real Hermes

> **No programmatic container-lifecycle management in tests.** The container is brought up manually via the dev `docker-compose.yml` from Phase 1.1. The test assumes the endpoint is already listening. This keeps test code simple and avoids shell-exec concerns.

**Files:**
- Create: `gateway/tests/integration/hermes/hermes-e2e.test.ts`
- Create: `gateway/tests/integration/hermes/README.md`

### Step 1.2.4a: Integration test

- [ ] Create `gateway/tests/integration/hermes/hermes-e2e.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { HttpHermesClient } from "../../../src/cerebrum/hermes-client";
import type { HermesProfileBinding } from "../../../src/cerebrum/hermes-client";
import type { HermesEvent } from "../../../src/cerebrum/hermes-event-types";

const HERMES_URL = process.env.HERMES_TEST_URL ?? "http://localhost:8643";
const HERMES_KEY = process.env.HERMES_TEST_KEY ?? "";

const SKIP_REASON = (() => {
  if (!process.env.OPENROUTER_API_KEY) return "OPENROUTER_API_KEY not set";
  if (!HERMES_KEY) return "HERMES_TEST_KEY not set";
  return null;
})();

async function pingHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${HERMES_URL}/health`, {
      headers: { Authorization: `Bearer ${HERMES_KEY}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe.skipIf(SKIP_REASON !== null)("HermesClient e2e against live container", () => {
  it("sanity: /health is reachable", async () => {
    const ok = await pingHealth();
    if (!ok) {
      throw new Error(
        `Hermes not reachable at ${HERMES_URL}. Start it with: cd deploy/docker && docker compose up -d hermes-alice`,
      );
    }
  });

  it("completes a simple turn, emits text deltas and completion", async () => {
    const binding: HermesProfileBinding = {
      userId: "test",
      url: HERMES_URL,
      apiKey: HERMES_KEY,
      conversationId: null,
    };
    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const events: HermesEvent[] = [];
    for await (const e of client.dispatch(
      {
        userId: "test",
        cycleId: `e2e-${Date.now()}`,
        userMessage: "Say exactly: OK",
        conversationId: null,
        maxOutputTokens: 32,
      },
      ctrl.signal,
      { bargedIn: () => false },
    )) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("created");
    expect(types).toContain("text.delta");
    expect(types[types.length - 1]).toBe("completed");
  }, 60_000);

  it("SSE disconnect on abort does not throw", async () => {
    const binding: HermesProfileBinding = {
      userId: "test",
      url: HERMES_URL,
      apiKey: HERMES_KEY,
      conversationId: null,
    };
    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const events: HermesEvent[] = [];
    const gen = client.dispatch(
      {
        userId: "test",
        cycleId: `e2e-abort-${Date.now()}`,
        userMessage: "Count from 1 to 1000 slowly with explanations.",
        conversationId: null,
        maxOutputTokens: 1024,
      },
      ctrl.signal,
      { bargedIn: () => false },
    );
    const first = await gen.next();
    if (first.value) events.push(first.value);
    ctrl.abort();
    for await (const e of gen) events.push(e);
    expect(events.length).toBeGreaterThan(0);
  }, 30_000);
});
```

### Step 1.2.4b: README

- [ ] Create `gateway/tests/integration/hermes/README.md`:

```markdown
# Hermes e2e integration tests

Tests run against a real `sentient-hermes:slim` container that you start
MANUALLY before running the suite. No programmatic docker-compose calls
in test code.

## Setup

1. Build the slim image (Phase 1.1 may have done this already):

    cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim .

2. Make sure the Phase 1.1 dev compose brings up `hermes-alice`. From repo root:

    cd deploy/docker && docker compose up -d hermes-alice

3. Verify it's up:

    curl -fsS -H "Authorization: Bearer $(cat deploy/docker/secrets/hermes_api_key_alice)" http://localhost:8643/health

## Running the tests

Requires three env vars:

- `OPENROUTER_API_KEY` — for the LLM call Hermes makes.
- `HERMES_TEST_URL` — default `http://localhost:8643`.
- `HERMES_TEST_KEY` — the bearer key from `deploy/docker/secrets/hermes_api_key_alice`.

Then:

    source scripts/env.sh
    export OPENROUTER_API_KEY=sk-or-v1-...
    export HERMES_TEST_KEY=$(cat deploy/docker/secrets/hermes_api_key_alice)
    bun run --filter @sentient/gateway test:int

Tests are `describe.skipIf(...)` — they skip cleanly if either env var is
missing, so `bun run ci` stays green without live API access.

## Teardown

    cd deploy/docker && docker compose down
```

### Step 1.2.4c: Wire test:int script

- [ ] Check `gateway/package.json`. If `test:int` is missing, add it:

```json
"scripts": {
  "test:int": "vitest run tests/integration"
}
```

- [ ] Ensure `test:int` is excluded from the default `test` / `test:unit` script.

### Step 1.2.4d: Verify (manually)

- [ ] Build the slim image (if not already):

```bash
cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim . && cd ../..
```

- [ ] Boot hermes-alice:

```bash
cd deploy/docker && docker compose up -d hermes-alice && cd ../..
```

- [ ] Wait for healthy:

```bash
docker ps --filter "name=hermes-alice" --format "{{.Status}}"
```

Expect `(healthy)` in ~30 s.

- [ ] Set env + run test:int:

```bash
export OPENROUTER_API_KEY=<your-key>
export HERMES_TEST_KEY=$(cat deploy/docker/secrets/hermes_api_key_alice)
source scripts/env.sh && bun run --filter @sentient/gateway test:int
```

Expect both e2e tests pass.

- [ ] Tear down:

```bash
cd deploy/docker && docker compose down && cd ../..
```

### Step 1.2.4e: Commit

```bash
git add gateway/tests/integration/hermes/ gateway/package.json
git commit -m "$(cat <<'EOF'
test(hermes): e2e integration suite against live Hermes container

Tests assume docker-compose is already running the dev hermes-alice
service (from Phase 1.1). Reads HERMES_TEST_URL, HERMES_TEST_KEY, and
OPENROUTER_API_KEY from env; gracefully skips if any are missing.
Keeps unit suite and ci stable without live API access.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.2.5 — Final quality gate

- [ ] Stop conflicting containers:

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}" | grep -v NAMES
```

- [ ] Run full CI (unit only, integration stays skipped):

```bash
source scripts/env.sh && bun run ci
```

Expected: green.

- [ ] Commit log check:

```bash
git log --oneline develop..HEAD
```

---

## Done

Phase 1.2 complete when:

- [ ] `sse-parser.ts` + tests.
- [ ] `hermes-client.ts` with real SSE consumer + tests (mocked fetch).
- [ ] `hermes-event-translator.ts` + tests.
- [ ] `hermes-dispatcher.ts` + tests.
- [ ] `gateway/tests/integration/hermes/` with e2e suite that passes when Hermes is manually running.
- [ ] `bun run ci` green.

**Proceed to** `2026-04-21-hermes-phase1.3-tts-chain.md`.
