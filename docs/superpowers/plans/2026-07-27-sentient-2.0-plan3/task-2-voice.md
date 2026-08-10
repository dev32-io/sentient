### Task 2: Voice pipeline — STT into the native turn, TTS out of it

**Spec:** §6 (voice on the native stream), §4.7 (barge-in / interrupt), §7.2 (audio queues, never replaced). Build-order slices 5 + 6.
**Depends on:** Task 1 (frozen wire contract + `TurnEmitter.audioStart/audioFrame/audioDone`).
**Wave:** 2 — runs concurrently with T3 (store/loop), T4 (`shared/web-sdk`), T5 (`shared/mobile-sdk`). This task is the only Wave-2 writer of `gateway/src/session-handlers/**` and `gateway/src/runtime/session-runtime.ts`.

Both directions land in ONE task because they share one composition-root decision and the same three files (`ws-handlers.ts`, `ws-session-configure.ts`, `session-runtime.ts`). Splitting them produces a merge conflict and two incompatible answers to "where does the synthesizer live."

#### Files

**Create**
- `gateway/src/session-handlers/stt-session.ts` — per-connection STT adapter owner (open, turn-mode relay, frame uplink, event fan-out to the runtime).
- `gateway/src/session-handlers/stt-session.test.ts`
- `gateway/src/session-handlers/ws-handlers-audio.test.ts`
- `gateway/src/session-handlers/mic-echo-guard.ts` — TTS-window mic suppression policy over the STT session.
- `gateway/src/session-handlers/session-voice-prefs.ts` — per-session `profile.json#voice.id` + `profile.json#audio` reader.
- `gateway/src/runtime/turn-voice.ts` — the per-turn TTS fork + per-session audio-drain serializer.
- `gateway/src/runtime/turn-voice.test.ts`

**Modify**
- `gateway/src/session-handlers/ws-helpers.ts` — add `stt: SttSession | null` to `SessionData` + `createEmptySessionData`.
- `gateway/src/session-handlers/ws-handlers.ts` — route inbound binary frames; handle `audio.start` / `audio.end`; tear the STT session down in `cleanupSession`; refresh the stale "Plan 3" header/default-case comments.
- `gateway/src/session-handlers/ws-session-configure.ts` — build the session's voice prefs, echo guard, synthesizer, and `TurnVoice`; pass the voice into `createSessionRuntime`.
- `gateway/src/runtime/session-runtime.ts` — accept `voice`, `begin()` it per turn, fork deltas, flush per tool call, `end()` on settle.
- `gateway/src/bootstrap/phase-services.ts` — 4th `voice` parameter on the `createSessionRuntime` factory.
- `gateway/src/bootstrap/create-gateway-services.ts` — same signature change on `GatewayServices.createSessionRuntime`.
- `gateway/src/tts/stages/stage-types.ts`, `gateway/src/tts/streaming-tts-synthesizer.ts`, `gateway/src/tts/text-stream-synthesizer.ts` — **comments only** (purged `broadcaster` / `speak-effect.ts` references).
- `gateway/config.yaml` — comment only (`connector.audio.start` → `turn.audio.start`).

**Do NOT touch:** `gateway/src/adapters/stt/**` (especially `local-stt-adapter.ts`'s `setTurnMode` dedup and `STT_DEFAULT_TURN_MODE`), `gateway/src/providers/tts/**`, `gateway/src/tts/**` behaviour, `gateway/src/runtime/react-loop.ts`, `gateway/src/runtime/cancellation.ts`, `gateway/src/tools/tool-broker.ts`.

---

#### Interfaces

**Consumes (already exists — verified in the tree)**

```ts
// gateway/src/adapters/stt/stt-adapter-types.ts
export type STTEvent =
  | { readonly type: "turn_started"; readonly turnIdx: number }
  | { readonly type: "transcript"; readonly turnIdx: number; readonly text: string }
  | { readonly type: "turn_dropped"; readonly turnIdx: number };

export interface STTAdapter {
  open(signal: AbortSignal): Promise<void>;
  send(pcm: Uint8Array): void;
  events(signal: AbortSignal): AsyncGenerator<STTEvent>;
  close(): Promise<void>;
  suppressInputFor(ms: number): void;   // ms=0 clears the window
  endUtterance(): void;                 // {"type":"flush"} — audio.end
  setTurnMode(mode: TurnMode): void;    // dedups internally; NEVER modify
}
export type STTAdapterFactory = (config: STTAdapterConfig) => STTAdapter;

// gateway/src/bootstrap/stt-factory.ts
export interface SttService {
  readonly adapterFactory: STTAdapterFactory;
  readonly adapterConfig: STTAdapterConfig;   // carries ttsEchoCooldownMs
}

// gateway/src/tts/text-stream-synthesizer.ts
export interface TextStreamSynthesizer {
  synthesize(textStream: AsyncIterable<TtsChunk>, signal: AbortSignal): AsyncIterable<AudioFrame>;
}
export interface AudioFrame { readonly data: Uint8Array; readonly encoding: string; readonly sampleRate: number; }

// gateway/src/tts/stages/stage-types.ts
export const FLUSH_SIGNAL: unique symbol;
export type TtsChunk = string | FlushSignal;

// gateway/src/bootstrap/create-gateway-services.ts
readonly stt: SttService | null;
readonly createSynthesizerFor: (getVoiceId: () => string | null) => TextStreamSynthesizer | null;
readonly profileStore: ProfileStore;          // get(userId) → Result<ProfileV1, ProfileStoreError>

// gateway/src/runtime/session-runtime.ts
runtime.submit({ kind: "conversational", text });   // the SAME seam text.input uses
runtime.bargeIn();                                  // aborts turn + TTS, keeps background tasks
runtime.interrupt();                                // aborts turn + TTS + background tasks
```

**Consumes from Task 1** — `gateway/src/runtime/turn-emitter.ts`'s `TurnEmitter` gains:

```ts
audioStart(turnId: string, encoding: "opus" | "pcm", sampleRate: number): void;  // → turn.audio.start
audioFrame(turnId: string, data: Uint8Array): void;                             // → outbound binary frame
audioDone(turnId: string): void;                                                // → turn.audio.done
```

Task 1 also owns `turnAborted` → `turn.aborted` **plus** `playback.stop`. This task never emits `playback.stop` itself and never renames a frame. Task 1 may also have added a `trigger` argument to `turnStarted` — **do not edit the `emitter.turnStarted(...)` line in `session-runtime.ts`**; only add lines around it. If any audio method's arity differs from the block above, adapt this task's call sites to whatever `turn-emitter.ts` actually declares. The frame names are frozen either way.

**Produces (later tasks rely on these exact names)**

```ts
// gateway/src/runtime/turn-voice.ts
export interface TurnAudioSink {
  audioStart(turnId: string, encoding: "opus" | "pcm", sampleRate: number): void;
  audioFrame(turnId: string, data: Uint8Array): void;
  audioDone(turnId: string): void;
}
export interface MicEchoGuard {
  onTtsStart(turnId: string): void;
  onTtsCancel(turnId: string): void;
}
export interface TurnVoiceStream {
  pushText(text: string): void;
  /** Idempotent per toolCallId — at most ONE FLUSH_SIGNAL per tool call. */
  flush(toolCallId: string): void;
  end(): void;
}
export interface TurnVoice { begin(turnId: string, signal: AbortSignal): TurnVoiceStream; }
export interface TurnVoiceDeps {
  synthesizer: TextStreamSynthesizer;
  sink: TurnAudioSink;
  echoGuard: MicEchoGuard;
  shouldSpeak: () => boolean;
  sessionId: string;
}
export function createTurnVoice(deps: TurnVoiceDeps): TurnVoice;

// gateway/src/session-handlers/stt-session.ts
export interface SttSession {
  start(turnMode: TurnMode): void;   // client audio.start
  end(): void;                       // client audio.end
  pushFrame(bytes: Uint8Array): void;// inbound binary WS frame
  suppressInputFor(ms: number): void;
  close(): void;
}
export interface SttSessionDeps {
  sessionId: string;
  factory: STTAdapterFactory;
  config: STTAdapterConfig;
  getRuntime: () => SessionRuntime | null;
}
export function createSttSession(deps: SttSessionDeps): SttSession;

// gateway/src/session-handlers/mic-echo-guard.ts
export function createMicEchoGuard(
  getStt: () => SttSession | null,
  cooldownMs: number | null,
  sessionId: string,
): MicEchoGuard;

// gateway/src/session-handlers/session-voice-prefs.ts
export interface SessionVoicePrefs { voiceId(): string | null; shouldSpeak(): boolean; }
export function createSessionVoicePrefs(store: ProfileStore, userId: string, sessionId: string): SessionVoicePrefs;

// gateway/src/runtime/session-runtime.ts
export interface SessionRuntimeDeps { /* …unchanged… */ voice?: TurnVoice | null; }

// gateway/src/bootstrap/create-gateway-services.ts + phase-services.ts
readonly createSessionRuntime:
  | ((principal: UserPrincipal, sessionId: string, emitter: TurnEmitter, voice?: TurnVoice | null) => SessionRuntime)
  | null;
```

---

#### Composition-root decision (read before writing any code)

**TTS is *composed* at the WS layer and *driven* inside `SessionRuntime`, on the turn's own `AbortController`.**

The turn's `AbortController` is created inside `createSessionRuntime`'s closure (`session-runtime.ts`'s `startTurn`) and is deliberately not exported. Wiring TTS at the WS layer with its own controller — the obvious-looking option — would mean `bargeIn()` / `interrupt()` abort the *turn* controller while the *TTS* controller keeps running: the user speaks over the assistant, the turn dies, and the assistant keeps talking. That is a direct violation of §4.7 ("barge-in aborts current turn **+ TTS playback**"), and no amount of extra plumbing at the WS layer fixes it without duplicating the abort fan-out that `cancellation.ts` already owns.

The rejected alternative — surfacing `controller` out of `SessionRuntime` — is worse: it hands every caller the ability to abort a turn *without* going through `cancellation.ts`, bypassing the cutoff-entry commit, the `signal.aborted || turn.settled` double-commit guard, and the `turnAborted` emit. Those are the invariants Plan 2 Task 8 exists to protect.

So: `ws-session-configure.ts` builds the session-scoped `TurnVoice` (it is the only place that knows the socket, the emitter, the user's profile, and the STT session) and hands it to `createSessionRuntime`. `startTurn` calls `voice.begin(turnId, controller.signal)` — the runtime gives the voice a signal it already owns. Result: **zero new cancellation code**; barge-in and interrupt cancel TTS for free, through the exact same abort that stops the provider stream.

Two consequences that are part of the design, not accidents:

1. **`TurnVoice` is session-scoped, not turn-scoped.** It holds a `tail` promise that serializes the *audio drain* across turns. One socket carries one binary stream with no per-frame turn id, so two turns draining concurrently would interleave frames between one `turn.audio.start` and the next — unattributable garbage on the client. Turn N+1's drain awaits turn N's. This is the gateway side of §7.2 ("queue, don't replace"): a new turn id never cancels in-flight audio, it queues behind it. Text still streams and buffers immediately, so nothing about the *text* path is delayed.
2. **`synthesize()` is lazy.** `createStreamingTtsSynthesizer` returns an un-started async generator; the local-tts session is created on the first `next()`. Queuing the drain therefore also defers the upstream TTS session — a turn aborted while queued never opens a socket at all.

---

#### Steps

- [ ] **Step 1: Write the failing STT-seam test.**

Create `gateway/src/session-handlers/stt-session.test.ts`:

```ts
// Pins the STT → SessionRuntime seam (spec §6, §4.7). Two process-boundary
// contracts live here: an STT `transcript` event MUST land on the SAME
// `runtime.submit({kind:"conversational"})` seam `text.input` uses, and an STT
// `turn_started` (mic onset) MUST call `runtime.bargeIn()` — the only
// production caller that method has. Zero network: a fake STTAdapter.

import { describe, expect, it } from "bun:test";
import type { TurnMode } from "@sentient/protocol";
import type { STTAdapter, STTAdapterConfig, STTEvent } from "../adapters/stt/stt-adapter-types.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { createSttSession } from "./stt-session.js";

const TEST_CONFIG: STTAdapterConfig = {
  url: "ws://localhost:0",
  language: "auto",
  pauseRenderLanguage: "en",
  inputSampleRate: 48000,
  ttsEchoCooldownMs: 2500,
  connectTimeoutMs: 10,
  audioFormat: "opus",
};

interface FakeAdapter {
  adapter: STTAdapter;
  emit(event: STTEvent): void;
  sent: Uint8Array[];
  turnModes: TurnMode[];
  flushes: number;
  suppressions: number[];
  closes: number;
}

function fakeAdapter(openError?: Error): FakeAdapter {
  const pendingEvents: STTEvent[] = [];
  let deliver: ((e: STTEvent | null) => void) | null = null;
  const f: FakeAdapter = {
    sent: [],
    turnModes: [],
    flushes: 0,
    suppressions: [],
    closes: 0,
    emit(event) {
      const d = deliver;
      if (d) {
        deliver = null;
        d(event);
        return;
      }
      pendingEvents.push(event);
    },
    adapter: {
      open: async () => {
        if (openError) throw openError;
      },
      send: (pcm) => {
        f.sent.push(pcm);
      },
      endUtterance: () => {
        f.flushes += 1;
      },
      setTurnMode: (mode) => {
        f.turnModes.push(mode);
      },
      suppressInputFor: (ms) => {
        f.suppressions.push(ms);
      },
      close: async () => {
        f.closes += 1;
        deliver?.(null);
        deliver = null;
      },
      async *events() {
        while (true) {
          const next = pendingEvents.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          const awaited = await new Promise<STTEvent | null>((resolve) => {
            deliver = resolve;
          });
          if (awaited === null) return;
          yield awaited;
        }
      },
    },
  };
  return f;
}

interface StubRuntime {
  runtime: SessionRuntime;
  submitted: Stimulus[];
  bargeIns: string[];
}

function stubRuntime(): StubRuntime {
  const submitted: Stimulus[] = [];
  const bargeIns: string[] = [];
  const runtime: SessionRuntime = {
    userId: "u_deadbeef" as SessionRuntime["userId"],
    submit: (s) => {
      submitted.push(s);
    },
    get running() {
      return false;
    },
    dispose: () => {},
    bargeIn: () => {
      bargeIns.push("barge-in");
    },
    interrupt: () => {},
  };
  return { runtime, submitted, bargeIns };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("createSttSession", () => {
  it("submits a conversational stimulus on an STT transcript event", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
    });

    session.start("semantic");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "turn on the lights" });
    await settle();

    expect(stub.submitted).toEqual([{ kind: "conversational", text: "turn on the lights" }]);
    session.close();
  });

  it("calls runtime.bargeIn() on an STT turn_started (mic onset)", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
    });

    session.start("semantic");
    await settle();
    fake.emit({ type: "turn_started", turnIdx: 1 });
    await settle();

    expect(stub.bargeIns).toEqual(["barge-in"]);
    expect(stub.submitted).toEqual([]);
    session.close();
  });

  it("drops a blank transcript instead of firing an empty turn", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
    });

    session.start("semantic");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "   " });
    await settle();

    expect(stub.submitted).toEqual([]);
    session.close();
  });

  it("relays the audio.start turnMode to the adapter and flushes on end()", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
    });

    session.start("manual");
    await settle();
    session.pushFrame(new Uint8Array([1, 2, 3]));
    session.end();

    expect(fake.turnModes).toEqual(["manual"]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.flushes).toBe(1);
    session.close();
  });

  it("drops frames without throwing when the adapter never connected", async () => {
    const fake = fakeAdapter(new Error("connect refused"));
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
    });

    session.start("semantic");
    await settle();

    expect(() => session.pushFrame(new Uint8Array([1]))).not.toThrow();
    expect(fake.sent).toEqual([]);
    session.close();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason.**

```bash
source scripts/env.sh && cd gateway/src && bun test session-handlers/stt-session.test.ts
```

Expected: a module-resolution failure naming `./stt-session.js` / `stt-session.ts` (the file does not exist yet), 0 tests run.

- [ ] **Step 3: Implement `gateway/src/session-handlers/stt-session.ts`.**

```ts
// SttSession (spec §6) — the per-connection owner of one STTAdapter.
//
// Inbound binary WS frames (mic audio) land here via `pushFrame`; STT's
// transcript events leave here as `runtime.submit({kind:"conversational"})`
// — the SAME stimulus seam `text.input` uses (ws-handlers.ts), so a spoken
// message and a typed message are indistinguishable to the ReAct loop.
// STT's `turn_started` (mic onset) is the barge-in trigger (spec §4.7):
// this is the ONLY production caller of `runtime.bargeIn()`.
//
// Connection policy — deliberately lean, no reconnect supervisor:
//   - Nothing is dialed until the client's first `audio.start`, so a
//     text-only browser tab never opens a socket to the STT service.
//   - `open()` failure is logged and left; the next `audio.start` (or the
//     next mic frame while the mic is open) retries. Frames arrive every
//     ~20-60ms, so a mid-session STT drop self-heals within one frame plus
//     connect time — no timers, no backoff constants, no new config.
//   - `setTurnMode` is replayed after every successful connect: a fresh STT
//     socket is implicitly "semantic" server-side. The adapter dedups
//     internally (local-stt-adapter.ts, tuned — never modify).

import type { TurnMode } from "@sentient/protocol";
import type { STTAdapter, STTAdapterConfig, STTAdapterFactory, STTEvent } from "../adapters/stt/stt-adapter-types.js";
import { getLog } from "../logging/logger.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";

const log = getLog(["sentient", "session-handlers", "stt-session"]);

/** STT's own server-side default — the mode a freshly connected socket is in. */
const INITIAL_TURN_MODE: TurnMode = "semantic";

export interface SttSession {
  /** Client `audio.start` — ensure a connection and relay the turn mode. */
  start(turnMode: TurnMode): void;
  /** Client `audio.end` — force-finalize any open STT turn. */
  end(): void;
  /** One inbound binary WS frame (mic audio, opus or pcm16 per config). */
  pushFrame(bytes: Uint8Array): void;
  /** Echo-suppression window (ms). `0` clears it. See mic-echo-guard.ts. */
  suppressInputFor(ms: number): void;
  /** Connection teardown — idempotent. */
  close(): void;
}

export interface SttSessionDeps {
  readonly sessionId: string;
  readonly factory: STTAdapterFactory;
  readonly config: STTAdapterConfig;
  /** Read fresh on every event: `session.configure` can re-mint the runtime. */
  readonly getRuntime: () => SessionRuntime | null;
}

export function createSttSession(deps: SttSessionDeps): SttSession {
  const { sessionId, factory, config, getRuntime } = deps;
  const lifetime = new AbortController();

  let adapter: STTAdapter | null = null;
  let connecting = false;
  let closed = false;
  let micOpen = false;
  let desiredTurnMode: TurnMode = INITIAL_TURN_MODE;

  function dispatch(event: STTEvent): void {
    const runtime = getRuntime();
    if (event.type === "turn_dropped") {
      log.debug("stt.turn-dropped", { sessionId, turnIdx: event.turnIdx });
      return;
    }
    if (!runtime) {
      log.warn("stt.event.no-runtime", {
        sessionId,
        eventType: event.type,
        reason: "orchestrator unconfigured, or session.configure has not minted a runtime",
      });
      return;
    }
    if (event.type === "turn_started") {
      // Barge-in (spec §4.7): fire on mic onset, BEFORE the transcript lands,
      // so the assistant stops talking as early as possible. Background tasks
      // keep running — that distinction lives in cancellation.ts.
      log.info("stt.barge-in", { sessionId, turnIdx: event.turnIdx });
      runtime.bargeIn();
      return;
    }
    const text = event.text.trim();
    if (text.length === 0) {
      log.debug("stt.transcript.blank", { sessionId, turnIdx: event.turnIdx, reason: "empty after trim" });
      return;
    }
    log.info("stt.transcript.submit", { sessionId, turnIdx: event.turnIdx, length: text.length });
    runtime.submit({ kind: "conversational", text });
  }

  async function consumeEvents(active: STTAdapter): Promise<void> {
    try {
      for await (const event of active.events(lifetime.signal)) {
        // A hook throw must never kill the event loop for the rest of the
        // session — the pre-purge adapter learned this the hard way.
        try {
          dispatch(event);
        } catch (err: unknown) {
          log.warn("stt.event.dispatch-failed", {
            sessionId,
            eventType: event.type,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      if (adapter === active) {
        adapter = null;
        log.info("stt.disconnected", { sessionId, micOpen, reason: "event stream ended" });
      }
    }
  }

  function connect(): void {
    if (closed || connecting || adapter !== null) return;
    connecting = true;
    const candidate = factory(config);
    log.info("stt.connecting", { sessionId, url: config.url, audioFormat: config.audioFormat });
    candidate
      .open(lifetime.signal)
      .then(() => {
        connecting = false;
        if (closed) {
          void candidate.close();
          return;
        }
        adapter = candidate;
        candidate.setTurnMode(desiredTurnMode);
        log.info("stt.connected", { sessionId, turnMode: desiredTurnMode });
        void consumeEvents(candidate);
      })
      .catch((err: unknown) => {
        connecting = false;
        log.warn("stt.connect-failed", {
          sessionId,
          url: config.url,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return {
    start(turnMode) {
      if (closed) return;
      micOpen = true;
      desiredTurnMode = turnMode;
      log.info("stt.audio-start", { sessionId, turnMode, connected: adapter !== null });
      if (adapter) {
        adapter.setTurnMode(turnMode);
        return;
      }
      connect();
    },

    end() {
      micOpen = false;
      log.info("stt.audio-end", { sessionId, connected: adapter !== null });
      adapter?.endUtterance();
    },

    pushFrame(bytes) {
      if (!adapter) {
        // Frame-driven reconnect: the mic is live but the socket is not.
        if (micOpen) connect();
        log.debug("stt.frame-dropped", { sessionId, byteSize: bytes.byteLength, reason: "no live STT socket" });
        return;
      }
      adapter.send(bytes);
    },

    suppressInputFor(ms) {
      adapter?.suppressInputFor(ms);
    },

    close() {
      if (closed) return;
      closed = true;
      micOpen = false;
      log.info("stt.close", { sessionId, wasConnected: adapter !== null });
      lifetime.abort();
      const active = adapter;
      adapter = null;
      void active?.close();
    },
  };
}
```

- [ ] **Step 4: Run to green.**

```bash
source scripts/env.sh && cd gateway/src && bun test session-handlers/stt-session.test.ts
```

Expected: `5 pass 0 fail`.

- [ ] **Step 5: Commit.**

```bash
git add gateway/src/session-handlers/stt-session.ts gateway/src/session-handlers/stt-session.test.ts
git commit -m "feat(gateway): per-session STT adapter owner feeding the native stimulus seam"
```

- [ ] **Step 6: Add the `stt` field to `SessionData`.**

In `gateway/src/session-handlers/ws-helpers.ts`, add the import and the field (leave every existing field and comment as-is):

```ts
import type { SttSession } from "./stt-session.js";
```

Inside `interface SessionData`, after `runtime`:

```ts
  /**
   * The connection's STT uplink (Plan 3 Task 2, spec §6). Null until the
   * client's first `audio.start` — a text-only session never dials the STT
   * service. Owns one STTAdapter; inbound binary WS frames route into it
   * (ws-handlers.ts) and its transcript events land on `runtime.submit`.
   */
  stt: SttSession | null;
```

And in `createEmptySessionData()`, after `runtime: null,`:

```ts
    stt: null,
```

- [ ] **Step 7: Write the failing WS-routing test.**

Create `gateway/src/session-handlers/ws-handlers-audio.test.ts`:

```ts
// Pins the WS-layer voice routing (spec §6). Inbound BINARY frames are mic
// audio and go to the STT uplink — a separate path from the outbound binary
// TTS stream, and one that must NEVER open pre-auth (a security boundary:
// unauthenticated bytes must not reach a service on the operator's host).
// `audio.start` / `audio.end` are protocol frames whose payloads (turnMode)
// must survive the hop. FakeWs double, no network.

import { describe, expect, it } from "bun:test";
import type { TurnMode } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { SttSession } from "./stt-session.js";
import { handleWebSocketMessage } from "./ws-handlers.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

interface SpyStt {
  session: SttSession;
  starts: TurnMode[];
  ends: number;
  frames: number;
  closes: number;
}

function spyStt(): SpyStt {
  const spy: SpyStt = {
    starts: [],
    ends: 0,
    frames: 0,
    closes: 0,
    session: {
      start: (mode) => {
        spy.starts.push(mode);
      },
      end: () => {
        spy.ends += 1;
      },
      pushFrame: () => {
        spy.frames += 1;
      },
      suppressInputFor: () => {},
      close: () => {
        spy.closes += 1;
      },
    },
  };
  return spy;
}

interface FakeWs {
  data: SessionData;
  sent: unknown[];
  send: (s: string) => void;
}

function fakeWs(authed: boolean, stt: SttSession | null): FakeWs {
  const data = createEmptySessionData();
  data.sessionId = "test-session";
  data.authState = authed ? "authed" : "pending";
  data.principal = createUserPrincipal("u_deadbeef", "adult", "home");
  data.stt = stt;
  const ws: FakeWs = {
    data,
    sent: [],
    send(s) {
      ws.sent.push(JSON.parse(s));
    },
  };
  return ws;
}

// Only the `stt` field is read by the branches under test.
const noSttServices = { stt: null } as unknown as GatewayServices;

describe("ws-handlers — inbound binary (mic audio)", () => {
  it("routes a binary frame to the STT uplink once authed", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      Buffer.from([1, 2, 3]),
      noSttServices,
    );

    expect(spy.frames).toBe(1);
  });

  it("drops a binary frame that arrives before auth completes", async () => {
    const spy = spyStt();
    const ws = fakeWs(false, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      Buffer.from([1, 2, 3]),
      noSttServices,
    );

    expect(spy.frames).toBe(0);
    expect(ws.sent).toEqual([]);
  });
});

describe("ws-handlers — audio.start / audio.end", () => {
  it("relays the audio.start turnMode to the STT uplink", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "audio.start", turnMode: "manual" }),
      noSttServices,
    );

    expect(spy.starts).toEqual(["manual"]);
  });

  it("defaults a turnMode-less audio.start to semantic (back-compat clients)", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "audio.start" }),
      noSttServices,
    );

    expect(spy.starts).toEqual(["semantic"]);
  });

  it("forwards audio.end to the STT uplink", async () => {
    const spy = spyStt();
    const ws = fakeWs(true, spy.session);

    await handleWebSocketMessage(
      ws as unknown as ServerWebSocket<SessionData>,
      JSON.stringify({ type: "audio.end" }),
      noSttServices,
    );

    expect(spy.ends).toBe(1);
  });

  it("is a safe no-op when STT is not configured on this gateway", async () => {
    const ws = fakeWs(true, null);

    await expect(
      handleWebSocketMessage(
        ws as unknown as ServerWebSocket<SessionData>,
        JSON.stringify({ type: "audio.start", turnMode: "semantic" }),
        noSttServices,
      ),
    ).resolves.toBeUndefined();

    expect(ws.data.stt).toBeNull();
  });
});
```

- [ ] **Step 8: Run it and confirm it fails for the right reason.**

```bash
source scripts/env.sh && cd gateway/src && bun test session-handlers/ws-handlers-audio.test.ts
```

Expected: the two binary tests fail (`spy.frames` is `0` where `1` is expected — `ws-handlers.ts` still drops all binary on `typeof message !== "string"`), and the three `audio.*` tests fail (`spy.starts`/`spy.ends` stay empty — those frames still hit the `default:` case).

- [ ] **Step 9: Implement the routing in `gateway/src/session-handlers/ws-handlers.ts`.**

Replace the stale header block (lines 37-50, the "…audio.start / audio.end / session.new / conversation.activate remain unhandled — voice and multi-conversation routing are Plan 3" paragraph) with:

```ts
// ---------------------------------------------------------------------------
// Message routing.
//
// `text.input` and `interrupt` route to `ws.data.runtime` (a SessionRuntime,
// minted in ws-session-configure.ts), which drives the native ReAct loop and
// streams replies back through `WsTurnEmitter` (ws-turn-emitter.ts).
//
// Voice (Plan 3 Task 2, spec §6) adds the audio path: `audio.start` /
// `audio.end` drive this connection's `SttSession` (stt-session.ts), and
// INBOUND binary frames are mic audio forwarded to it. Inbound and outbound
// binary are separate paths — outbound TTS frames leave through the turn
// emitter, never through this router.
//
// `session.new` / `conversation.activate` (multi-conversation) and
// `tool.confirm` (superseded by `permission.response`, Task 6) are still
// received-but-unhandled.
// ---------------------------------------------------------------------------
```

Add the imports:

```ts
import type { TurnMode } from "@sentient/protocol";
import { createSttSession } from "./stt-session.js";
import type { SttSession } from "./stt-session.js";
```

Replace the binary early-return at the top of `handleWebSocketMessage`:

```ts
  // Inbound binary = mic audio → STT (spec §6). Never routed through the
  // outbound emitter. Dropped before auth completes: unauthenticated bytes
  // must not reach the STT service running on the operator's host.
  if (typeof message !== "string") {
    if (ws.data.authState !== "authed") {
      log.warn("binary-frame-preauth", {
        sessionId: ws.data.sessionId,
        byteSize: message.byteLength,
        reason: "audio frame arrived before auth completed",
      });
      return;
    }
    ws.data.stt?.pushFrame(message);
    return;
  }
```

(`Buffer` extends `Uint8Array`, so it satisfies `pushFrame(bytes: Uint8Array)` with no copy.)

Add the two cases to the `switch`, immediately after the `interrupt` case:

```ts
    case "audio.start":
      // The mic opened. Lazily dial STT (a text-only session never does) and
      // relay the client's turn authority (manual = hold-to-talk).
      ensureSttSession(ws, services)?.start(msg.turnMode);
      return;

    case "audio.end":
      // PTT release / mic off — force-finalize any open STT turn now.
      ws.data.stt?.end();
      return;
```

Update the `default:` case comment to:

```ts
    default:
      // session.new / conversation.activate (multi-conversation) and
      // tool.confirm (replaced by permission.response, Task 6) have no
      // handler yet. Received but unhandled.
      log.debug("message-unhandled", { type: msg.type, reason: "no handler in this slice" });
      return;
```

Add the helper below `handleWebSocketMessage`:

```ts
/**
 * Lazily mints this connection's STT uplink on the first `audio.start`.
 * Returns null when the gateway has no `stt:` config block at all — a
 * text-capable deployment, not an error. The runtime is read through a
 * getter, not captured, so a re-`session.configure` that re-mints
 * `ws.data.runtime` cannot strand transcripts on a dead runtime.
 */
function ensureSttSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): SttSession | null {
  if (ws.data.stt) return ws.data.stt;
  if (!services.stt) {
    log.warn("audio.start.no-stt", { sessionId: ws.data.sessionId, reason: "no stt: block in config.yaml" });
    return null;
  }
  const session = createSttSession({
    sessionId: ws.data.sessionId ?? "unbound",
    factory: services.stt.adapterFactory,
    config: services.stt.adapterConfig,
    getRuntime: () => ws.data.runtime,
  });
  ws.data.stt = session;
  log.info("stt-session-created", { sessionId: ws.data.sessionId });
  return session;
}
```

And in `cleanupSession`, next to the existing runtime teardown:

```ts
  ws.data.stt?.close();
  ws.data.stt = null;
```

Note the unused-import guard: `TurnMode` is only needed if you annotate anything explicitly — `msg.turnMode` is already typed by the zod schema, so **drop the `TurnMode` import if `tsc` flags it** (`noUnusedLocals` is on).

- [ ] **Step 10: Run both WS test files to green, then commit.**

```bash
source scripts/env.sh && cd gateway/src && bun test session-handlers/
```

Expected: all files in `session-handlers/` pass, including the pre-existing `ws-handlers-routing.test.ts` (5 tests) and `ws-auth-gate.test.ts`.

```bash
git add gateway/src/session-handlers/ws-handlers.ts gateway/src/session-handlers/ws-helpers.ts gateway/src/session-handlers/ws-handlers-audio.test.ts
git commit -m "feat(gateway): route mic audio and audio.start/end into the session STT uplink"
```

- [ ] **Step 11: Write the failing TurnVoice test.**

Create `gateway/src/runtime/turn-voice.test.ts`:

```ts
// Pins three TurnVoice invariants (spec §4.7, §6, §7.2):
//   1. ONE FLUSH_SIGNAL per tool call. The loop's `onToolUpdate` fires on
//      every status transition (running → done/error, plus a second
//      "running" carrying taskId for background dispatch); the deleted
//      forkTextDeltas flushed once per tool START. Multiple flushes per call
//      make local-tts split a sentence mid-clause.
//   2. Turn N+1's audio NEVER interleaves with turn N's. One socket, one
//      binary stream, no per-frame turn id — the gateway must serialize.
//   3. An aborted turn emits NO turn.audio.done, and clears the mic echo
//      window (the user is speaking; their frames must reach STT now).

import { describe, expect, it } from "bun:test";
import { FLUSH_SIGNAL, type TtsChunk } from "../tts/stages/stage-types.js";
import type { AudioFrame, TextStreamSynthesizer } from "../tts/text-stream-synthesizer.js";
import type { MicEchoGuard, TurnAudioSink } from "./turn-voice.js";
import { createTurnVoice } from "./turn-voice.js";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const FRAME: AudioFrame = { data: new Uint8Array([9, 9]), encoding: "opus", sampleRate: 48000 };

interface FakeCall {
  chunks: TtsChunk[];
  emit(frame: AudioFrame): void;
  finish(): void;
}

interface FakeSynth {
  synthesizer: TextStreamSynthesizer;
  calls: FakeCall[];
}

function fakeSynthesizer(): FakeSynth {
  const calls: FakeCall[] = [];
  const synthesizer: TextStreamSynthesizer = {
    synthesize(textStream, signal) {
      const queued: AudioFrame[] = [];
      let deliver: ((frame: AudioFrame | null) => void) | null = null;
      const call: FakeCall = {
        chunks: [],
        emit(frame) {
          const d = deliver;
          if (d) {
            deliver = null;
            d(frame);
            return;
          }
          queued.push(frame);
        },
        finish() {
          const d = deliver;
          deliver = null;
          d?.(null);
        },
      };
      calls.push(call);
      return (async function* () {
        // Mirror the real synthesizer: drain text in the background so
        // pushText() never blocks on frame consumption.
        void (async () => {
          for await (const chunk of textStream) call.chunks.push(chunk);
        })();
        while (!signal.aborted) {
          const next = queued.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          const awaited = await new Promise<AudioFrame | null>((resolve) => {
            deliver = resolve;
            signal.addEventListener("abort", () => resolve(null), { once: true });
          });
          if (awaited === null) return;
          yield awaited;
        }
      })();
    },
  };
  return { synthesizer, calls };
}

interface SinkEvent {
  type: "start" | "frame" | "done";
  turnId: string;
}

function recordingSink(): { sink: TurnAudioSink; events: SinkEvent[] } {
  const events: SinkEvent[] = [];
  return {
    events,
    sink: {
      audioStart: (turnId) => events.push({ type: "start", turnId }),
      audioFrame: (turnId) => events.push({ type: "frame", turnId }),
      audioDone: (turnId) => events.push({ type: "done", turnId }),
    },
  };
}

function recordingGuard(): { guard: MicEchoGuard; started: string[]; cancelled: string[] } {
  const started: string[] = [];
  const cancelled: string[] = [];
  return {
    started,
    cancelled,
    guard: {
      onTtsStart: (turnId) => started.push(turnId),
      onTtsCancel: (turnId) => cancelled.push(turnId),
    },
  };
}

describe("createTurnVoice", () => {
  it("pushes exactly one FLUSH_SIGNAL per tool call, however many tool updates fire", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => true,
      sessionId: "sess-1",
    });

    const controller = new AbortController();
    const speech = voice.begin("turn-a", controller.signal);
    speech.pushText("Let me check.");
    speech.flush("call-1"); // tool "running"
    speech.flush("call-1"); // same tool, "done"
    speech.flush("call-2"); // a second tool
    speech.end();
    await settle();
    synth.calls[0]?.finish(); // let the drain finish so no generator dangles

    expect(synth.calls[0]?.chunks).toEqual(["Let me check.", FLUSH_SIGNAL, FLUSH_SIGNAL]);
  });

  it("never emits a later turn's audio before the earlier turn's drain finishes", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => true,
      sessionId: "sess-1",
    });

    const first = new AbortController();
    const second = new AbortController();
    const a = voice.begin("turn-a", first.signal);
    const b = voice.begin("turn-b", second.signal);
    a.pushText("first");
    a.end();
    b.pushText("second");
    b.end();

    // Turn B produces its audio FIRST — it still must not reach the socket.
    synth.calls[1]?.emit(FRAME);
    synth.calls[1]?.finish();
    await settle();
    expect(sink.events).toEqual([]);

    synth.calls[0]?.emit(FRAME);
    synth.calls[0]?.finish();
    await settle();

    expect(sink.events).toEqual([
      { type: "start", turnId: "turn-a" },
      { type: "frame", turnId: "turn-a" },
      { type: "done", turnId: "turn-a" },
      { type: "start", turnId: "turn-b" },
      { type: "frame", turnId: "turn-b" },
      { type: "done", turnId: "turn-b" },
    ]);
  });

  it("emits no audio.done and clears the mic echo window when the turn aborts", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => true,
      sessionId: "sess-1",
    });

    const controller = new AbortController();
    const speech = voice.begin("turn-a", controller.signal);
    speech.pushText("I was saying");
    synth.calls[0]?.emit(FRAME);
    await settle();
    expect(guard.started).toEqual(["turn-a"]);

    controller.abort();
    await settle();

    expect(sink.events.some((e) => e.type === "done")).toBe(false);
    expect(guard.cancelled).toEqual(["turn-a"]);
  });

  it("synthesizes nothing when the user's profile has TTS off", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => false,
      sessionId: "sess-1",
    });

    const controller = new AbortController();
    const speech = voice.begin("turn-a", controller.signal);
    speech.pushText("silence please");
    speech.end();
    await settle();

    expect(synth.calls).toEqual([]);
    expect(sink.events).toEqual([]);
  });
});
```

- [ ] **Step 12: Run it and confirm it fails for the right reason.**

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/turn-voice.test.ts
```

Expected: a module-resolution failure naming `./turn-voice.js`, 0 tests run.

- [ ] **Step 13: Implement `gateway/src/runtime/turn-voice.ts`.**

```ts
// TurnVoice (spec §6, §4.7, §7.2) — the fork from the native loop's text
// deltas into the TTS pipeline, and the session's outbound audio serializer.
//
// Composition: built at the WS layer (ws-session-configure.ts, which knows
// the socket, the emitter, and the user's profile) and handed to
// SessionRuntime, which calls `begin(turnId, signal)` with the TURN'S OWN
// AbortSignal. That signal ownership is the whole point: barge-in and
// interrupt abort the turn's controller (cancellation.ts), and TTS dies with
// it at no extra cost. A TTS controller minted anywhere else would survive
// both gestures and keep the assistant talking over the user.
//
// Audio serialization: one WebSocket carries one binary stream and the frame
// header has no turn id, so two turns draining at once would interleave
// frames between one `turn.audio.start` and the next. Each `begin()` chains
// its drain behind the previous turn's — the gateway side of §7.2's "queue,
// don't replace". A new turn NEVER cancels in-flight audio (spec §4.6/§7.2:
// the gateway never stops its own audio); only the user does, via abort.
// Text still buffers immediately, so nothing about the text path waits.
//
// `TextStreamSynthesizer.synthesize` returns a LAZY async generator (see
// streaming-tts-synthesizer.ts) — the upstream local-tts session is not
// created until the first `next()`. A turn aborted while its drain is still
// queued therefore never opens a socket at all.

import { getLog } from "../logging/logger.js";
import { FLUSH_SIGNAL, type TtsChunk } from "../tts/stages/stage-types.js";
import type { AudioFrame, TextStreamSynthesizer } from "../tts/text-stream-synthesizer.js";

const log = getLog(["sentient", "runtime", "turn-voice"]);

/** Outbound audio frames, narrowed to what this module needs. `TurnEmitter`
 *  (turn-emitter.ts) satisfies it structurally. */
export interface TurnAudioSink {
  audioStart(turnId: string, encoding: "opus" | "pcm", sampleRate: number): void;
  audioFrame(turnId: string, data: Uint8Array): void;
  audioDone(turnId: string): void;
}

/** Mic suppression around a TTS window. Declared here (not in
 *  session-handlers/) so the dependency points inward: the WS-layer
 *  implementation (mic-echo-guard.ts) imports this type, never the reverse. */
export interface MicEchoGuard {
  onTtsStart(turnId: string): void;
  onTtsCancel(turnId: string): void;
}

export interface TurnVoiceStream {
  /** One assistant text delta from the loop. */
  pushText(text: string): void;
  /**
   * The loop paused text to call a tool — tell local-tts to speak what it
   * has buffered instead of holding a short pre-tool acknowledgement
   * ("Let me check.") for the whole tool round-trip. IDEMPOTENT per
   * `toolCallId`: `onToolUpdate` fires on every status transition, and a
   * second flush mid-tool-call would split the sentence again.
   */
  flush(toolCallId: string): void;
  /** No more text this turn — lets the synthesizer finalize its tail. */
  end(): void;
}

export interface TurnVoice {
  begin(turnId: string, signal: AbortSignal): TurnVoiceStream;
}

export interface TurnVoiceDeps {
  readonly synthesizer: TextStreamSynthesizer;
  readonly sink: TurnAudioSink;
  readonly echoGuard: MicEchoGuard;
  /** Read per turn — the user's profile.json audio prefs. */
  readonly shouldSpeak: () => boolean;
  readonly sessionId: string;
}

const SILENT_STREAM: TurnVoiceStream = {
  pushText() {},
  flush() {},
  end() {},
};

interface ChunkQueue {
  readonly stream: AsyncIterable<TtsChunk>;
  push(chunk: TtsChunk): void;
  close(): void;
}

/** Text-delta queue feeding the synthesizer. Ends on abort as well as on
 *  `close()`: the synthesizer's producer loop only re-checks `signal.aborted`
 *  when the text stream yields, so a turn aborted mid-silence would otherwise
 *  leave it awaiting a chunk that never comes. */
function createChunkQueue(signal: AbortSignal): ChunkQueue {
  const items: TtsChunk[] = [];
  let pending: ((result: IteratorResult<TtsChunk>) => void) | null = null;
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    const resolve = pending;
    pending = null;
    resolve?.({ value: undefined, done: true });
  }

  signal.addEventListener("abort", close, { once: true });

  return {
    stream: {
      [Symbol.asyncIterator](): AsyncIterator<TtsChunk> {
        return {
          next(): Promise<IteratorResult<TtsChunk>> {
            const next = items.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise<IteratorResult<TtsChunk>>((resolve) => {
              pending = resolve;
            });
          },
        };
      },
    },
    push(chunk) {
      if (closed) return;
      const resolve = pending;
      if (resolve) {
        pending = null;
        resolve({ value: chunk, done: false });
        return;
      }
      items.push(chunk);
    },
    close,
  };
}

/** The provider yields "opus" today (local-tts-provider.ts's LIVE_ENCODING).
 *  The wire contract admits exactly "opus" | "pcm", so narrow here rather
 *  than widening the frame schema. */
function toWireEncoding(raw: string, turnId: string): "opus" | "pcm" {
  if (raw === "opus") return "opus";
  if (raw === "pcm") return "pcm";
  log.warn("turn-voice.audio.unknown-encoding", {
    turnId,
    encoding: raw,
    reason: "provider encoding outside the wire contract — declaring pcm",
  });
  return "pcm";
}

async function drainAudio(
  deps: TurnVoiceDeps,
  turnId: string,
  frames: AsyncIterable<AudioFrame>,
  signal: AbortSignal,
): Promise<void> {
  const { sink, echoGuard, sessionId } = deps;
  const beganAtMs = Date.now();
  let started = false;
  let frameCount = 0;
  let bytesSent = 0;

  try {
    if (signal.aborted) {
      log.info("turn-voice.drain.skipped", { sessionId, turnId, reason: "aborted while queued behind a prior turn" });
      return;
    }
    for await (const frame of frames) {
      if (signal.aborted) return;
      if (!started) {
        started = true;
        // Suppress the mic for the AEC convergence window at the exact
        // moment audio starts leaving — not when synthesis started, which
        // may have been queued behind a previous turn.
        echoGuard.onTtsStart(turnId);
        const encoding = toWireEncoding(frame.encoding, turnId);
        sink.audioStart(turnId, encoding, frame.sampleRate);
        log.info("turn-voice.audio.start", {
          sessionId,
          turnId,
          encoding,
          sampleRate: frame.sampleRate,
          firstFrameMs: Date.now() - beganAtMs,
        });
      }
      sink.audioFrame(turnId, frame.data);
      frameCount += 1;
      bytesSent += frame.data.byteLength;
      log.debug("turn-voice.audio.frame", { sessionId, turnId, frameIndex: frameCount, byteSize: frame.data.byteLength });
    }
    if (started && !signal.aborted) {
      sink.audioDone(turnId);
      log.info("turn-voice.audio.done", { sessionId, turnId, frameCount, bytesSent, elapsedMs: Date.now() - beganAtMs });
    }
  } catch (err: unknown) {
    log.warn("turn-voice.drain.failed", {
      sessionId,
      turnId,
      frameCount,
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (signal.aborted) {
      // Barge-in / interrupt: the user is talking NOW. Clear the echo window
      // instead of leaving the mic muted for the rest of the cooldown.
      echoGuard.onTtsCancel(turnId);
      log.info("turn-voice.audio.cancelled", { sessionId, turnId, frameCount, bytesSent });
    }
  }
}

export function createTurnVoice(deps: TurnVoiceDeps): TurnVoice {
  // Serializes the audio DRAIN across turns — see the file header.
  let tail: Promise<void> = Promise.resolve();

  return {
    begin(turnId, signal) {
      if (!deps.shouldSpeak()) {
        log.info("turn-voice.silent", { sessionId: deps.sessionId, turnId, reason: "profile audio prefs disable TTS" });
        return SILENT_STREAM;
      }
      if (signal.aborted) {
        log.info("turn-voice.silent", { sessionId: deps.sessionId, turnId, reason: "turn already aborted" });
        return SILENT_STREAM;
      }

      const queue = createChunkQueue(signal);
      const frames = deps.synthesizer.synthesize(queue.stream, signal);
      const flushedToolCalls = new Set<string>();
      const previous = tail;
      tail = (async () => {
        try {
          await previous;
        } catch {
          /* the prior turn's drain logged its own failure */
        }
        await drainAudio(deps, turnId, frames, signal);
      })();

      log.info("turn-voice.begin", { sessionId: deps.sessionId, turnId });

      return {
        pushText(text) {
          queue.push(text);
        },
        flush(toolCallId) {
          if (flushedToolCalls.has(toolCallId)) return;
          flushedToolCalls.add(toolCallId);
          log.debug("turn-voice.flush", { sessionId: deps.sessionId, turnId, toolCallId });
          queue.push(FLUSH_SIGNAL);
        },
        end() {
          queue.close();
          log.debug("turn-voice.end", { sessionId: deps.sessionId, turnId });
        },
      };
    },
  };
}
```

- [ ] **Step 14: Run to green and commit.**

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/turn-voice.test.ts
```

Expected: `4 pass 0 fail`.

```bash
git add gateway/src/runtime/turn-voice.ts gateway/src/runtime/turn-voice.test.ts
git commit -m "feat(gateway): TurnVoice — per-turn TTS fork with per-session audio serialization"
```

- [ ] **Step 15: Implement the mic echo guard.**

Create `gateway/src/session-handlers/mic-echo-guard.ts`:

```ts
// Mic echo guard — hard-mute the STT uplink for a cooldown window at TTS
// start so the client's WebRTC AEC converges on the initial burst.
// `stt.tts_echo_cooldown_ms` (config.yaml) is the window; residual echo past
// it is handled at the client edge (RNNoise + speech-prob gate), so there is
// no gateway-side energy gate.
//
// Implements runtime/turn-voice.ts's MicEchoGuard: the interface lives with
// its consumer (the runtime), the implementation with the resource it drives
// (the WS-layer STT session). Dependencies point inward.

import { getLog } from "../logging/logger.js";
import type { MicEchoGuard } from "../runtime/turn-voice.js";
import type { SttSession } from "./stt-session.js";

const log = getLog(["sentient", "session-handlers", "mic-echo-guard"]);

const CLEAR_SUPPRESSION_MS = 0;

/**
 * @param getStt   read lazily — the STT session is minted on the first
 *                 `audio.start`, which may be long after this guard is built.
 * @param cooldownMs `null` when the gateway has no `stt:` config (nothing to
 *                 suppress); otherwise `stt.tts_echo_cooldown_ms`.
 */
export function createMicEchoGuard(
  getStt: () => SttSession | null,
  cooldownMs: number | null,
  sessionId: string,
): MicEchoGuard {
  return {
    onTtsStart(turnId) {
      if (cooldownMs === null) return;
      const stt = getStt();
      if (!stt) return;
      stt.suppressInputFor(cooldownMs);
      log.info("mic-suppress.tts-start", { sessionId, turnId, cooldownMs });
    },
    onTtsCancel(turnId) {
      const stt = getStt();
      if (!stt) return;
      stt.suppressInputFor(CLEAR_SUPPRESSION_MS);
      log.info("mic-suppress.cleared", {
        sessionId,
        turnId,
        reason: "tts cancelled — the user is speaking, their frames must reach STT now",
      });
    },
  };
}
```

No test: this is a two-line policy over an already-tested primitive (`STTAdapter.suppressInputFor`), and its effect is asserted through `turn-voice.test.ts`'s guard assertions. Adding one would be the "internal collaborator" test the testing rule forbids.

- [ ] **Step 16: Implement the per-session voice preferences.**

Create `gateway/src/session-handlers/session-voice-prefs.ts`:

```ts
// Per-session voice preferences, read once from the authenticated user's
// profile.json (spec §6). Two values:
//   - voice.id     → the local-tts voice pack this session synthesizes with.
//                    Null falls back to config.yaml's `tts.voice_id`.
//   - audio.{ttsEnabled,channel} → whether this session speaks at all.
//
// Hydration is fire-and-forget: `handleSessionConfigure` is synchronous, and
// a profile read is milliseconds against the seconds between session.configure
// and the first spoken reply. Both getters are re-evaluated per turn (voiceId
// per synthesizer session, shouldSpeak per `TurnVoice.begin`), so a read that
// lands late is picked up by the next turn rather than being lost. Defaults
// (no voice override, speaking enabled) match profileV1Schema's own defaults,
// so an unreadable profile degrades to the gateway-wide voice, not silence.

import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";

const log = getLog(["sentient", "session-handlers", "voice-prefs"]);

export interface SessionVoicePrefs {
  /** profile.json#voice.id, or null to use the gateway-wide default voice. */
  voiceId(): string | null;
  /** False when the user routed this profile to text or disabled TTS. */
  shouldSpeak(): boolean;
}

export function createSessionVoicePrefs(store: ProfileStore, userId: string, sessionId: string): SessionVoicePrefs {
  let voiceId: string | null = null;
  let speak = true;

  void store
    .get(userId)
    .then((result) => {
      if (!result.ok) {
        log.warn("voice-prefs.profile-read-failed", {
          sessionId,
          userId,
          reason: result.error,
          fallback: "gateway default voice, speaking enabled",
        });
        return;
      }
      voiceId = result.value.voice.id;
      speak = result.value.audio.ttsEnabled && result.value.audio.channel === "voice";
      log.info("voice-prefs.loaded", { sessionId, userId, voiceId, speak });
    })
    .catch((err: unknown) => {
      log.warn("voice-prefs.profile-read-threw", {
        sessionId,
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    voiceId: () => voiceId,
    shouldSpeak: () => speak,
  };
}
```

- [ ] **Step 17: Give `SessionRuntime` the voice.**

In `gateway/src/runtime/session-runtime.ts`:

Add the import next to the other `./` imports:

```ts
import type { TurnVoice, TurnVoiceStream } from "./turn-voice.js";
```

Add the dep (optional so the text-only `@live` harness in `bootstrap/native-brain-text.test.ts` and `session-runtime.test.ts` keep compiling unchanged):

```ts
export interface SessionRuntimeDeps {
  principal: UserPrincipal;
  sessionId: string;
  accessManager: AccessManager;
  provider: ProviderClient;
  broker: ToolBroker;
  emitter: TurnEmitter;
  systemPrompt: string;
  config: OrchestratorConfig;
  /**
   * This session's TTS fork (spec §6). Built at the WS layer and handed in
   * so the turn's OWN AbortController drives it — see turn-voice.ts's header
   * for why a TTS controller minted anywhere else would survive barge-in.
   * Null/absent for text-only sessions (no `tts:` config, headless harness).
   */
  voice?: TurnVoice | null;
}
```

Add the per-turn handle to `InFlightTurn`:

```ts
interface InFlightTurn {
  turnId: string;
  controller: AbortController;
  settled: boolean;
  /** This turn's TTS text sink, or null when the session is text-only. */
  speech: TurnVoiceStream | null;
}
```

In `createSessionRuntime`, after the existing destructure:

```ts
  const voice = deps.voice ?? null;
```

In `startTurn`, replace the two lines that build the controller and set `inFlight`:

```ts
    const controller = new AbortController();
    // The turn's own signal drives TTS — barge-in/interrupt abort it and the
    // audio dies with the turn, with no extra cancellation path (spec §4.7).
    const speech = voice ? voice.begin(turnId, controller.signal) : null;
    inFlight = { turnId, controller, settled: false, speech };
```

In the same function's `loopDeps`, extend the two existing callbacks (keep every existing line and comment):

```ts
      onTextDelta: (id, text) => {
        turnText += text;
        emitter.textDelta(id, text);
        speech?.pushText(text);
      },
      onToolUpdate: (id, u) => {
        turnText = "";
        emitter.toolUpdate(id, u);
        // Flush what local-tts has buffered so a short pre-tool line is
        // spoken now, not after the tool round-trip. `onToolUpdate` fires on
        // EVERY status transition; `flush` is idempotent per toolCallId
        // (turn-voice.ts) so a tool call flushes exactly once.
        speech?.flush(u.toolCallId);
      },
```

In `onTurnSettled`, capture the speech handle before clearing `inFlight`, and close the text stream:

```ts
  function onTurnSettled(turnId: string, result: { completed: boolean; iterations: number }): void {
    const speech = inFlight?.turnId === turnId ? inFlight.speech : null;
    inFlight = null;
    // No more deltas for this turn — let the synthesizer finalize its tail.
    // On an aborted turn this is already a no-op (the abort closed the queue).
    speech?.end();
    log.info("session-runtime.turn.end", {
```

Leave the rest of `onTurnSettled`, `emitter.turnStarted(...)`, and every cancellation path untouched.

- [ ] **Step 18: Thread the voice through the composition root.**

In `gateway/src/bootstrap/create-gateway-services.ts`, add the import:

```ts
import type { TurnVoice } from "../runtime/turn-voice.js";
```

and change the `GatewayServices` field (comment retained, one line added):

```ts
  readonly createSessionRuntime:
    | ((principal: UserPrincipal, sessionId: string, emitter: TurnEmitter, voice?: TurnVoice | null) => SessionRuntime)
    | null;
```

In `gateway/src/bootstrap/phase-services.ts`, add the same import, then make the identical signature change in **three** places: `PhaseServicesOutput.createSessionRuntime`, `OrchestratorServices.createSessionRuntime`, and `buildCreateSessionRuntime`'s return type. Then in `buildCreateSessionRuntime`'s returned closure, accept and forward it:

```ts
  return (principal, sessionId, emitter, voice) => {
```

and, in the `buildSessionRuntime({...})` call at the bottom of that closure, add one line after `config: orchestratorCfg,`:

```ts
      voice: voice ?? null,
```

The parameter is optional, so `bootstrap/native-brain-text.test.ts`'s 3-argument `createSessionRuntime(alice, TEST_SESSION_ID, emitter)` call keeps compiling — a text-only `@live` walk correctly gets no voice.

- [ ] **Step 19: Compose the voice at the WS layer.**

In `gateway/src/session-handlers/ws-session-configure.ts`, add the imports:

```ts
import { createTurnVoice } from "../runtime/turn-voice.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import { createSessionVoicePrefs } from "./session-voice-prefs.js";
```

Replace the body of the `if (services.createSessionRuntime) { try { … } }` block's happy path (the two lines that build the emitter and the runtime) with:

```ts
      const emitter = createWsTurnEmitter(ws);
      // Voice composition (spec §6). Built HERE because this is the only
      // place that knows the socket, the emitter, the authenticated user's
      // profile, and this connection's STT session — but DRIVEN inside
      // SessionRuntime on the turn's own AbortController, so barge-in and
      // interrupt cancel TTS through the same abort that stops the provider
      // stream. See runtime/turn-voice.ts's header.
      const voicePrefs = createSessionVoicePrefs(services.profileStore, userId, sessionId);
      const echoGuard = createMicEchoGuard(
        () => ws.data.stt,
        services.stt?.adapterConfig.ttsEchoCooldownMs ?? null,
        sessionId,
      );
      const synthesizer = services.createSynthesizerFor(() => voicePrefs.voiceId());
      const voice = synthesizer
        ? createTurnVoice({
            synthesizer,
            sink: emitter,
            echoGuard,
            shouldSpeak: () => voicePrefs.shouldSpeak(),
            sessionId,
          })
        : null;
      ws.data.runtime = services.createSessionRuntime(principal, sessionId, emitter, voice);
```

Make the outcome visible in the log trail so a silent session is diagnosable without a debugger. Declare the flag **above** the `if (services.createSessionRuntime)` block:

```ts
  let hasVoice = false;
```

set it inside the block, immediately after the `voice` const:

```ts
      hasVoice = voice !== null;
```

and add one field to the existing `session-configured` log call, right after `hasRuntime`:

```ts
    hasRuntime: ws.data.runtime !== null,
    hasVoice,
```

Do **not** call `services.createSynthesizerFor` a second time to derive this — each call builds another synthesizer.

Finally, extend this file's header comment: after the "Plan 2 Task 10 adds the one piece of orchestrator wiring…" paragraph, append:

```ts
// Plan 3 Task 2 adds the voice half: this handler also composes the session's
// `TurnVoice` (profile-backed voice id + audio prefs, mic echo guard, TTS
// synthesizer) and hands it to `createSessionRuntime`, so the ReAct loop's
// text deltas fork into TTS on the turn's own AbortController. The STT half
// is lazy — ws-handlers.ts mints `ws.data.stt` on the first `audio.start`.
```

- [ ] **Step 20: Full gateway verification.**

```bash
source scripts/env.sh && cd gateway && bun run typecheck && cd src && bun test
```

Expected: typecheck clean; every gateway unit test passes, including the untouched `runtime/session-runtime.test.ts`, `runtime/react-loop.test.ts`, `runtime/cancellation` regressions, and `adapters/stt/local-stt-adapter.test.ts`. If `noUnusedLocals` flags the `TurnMode` import added in Step 9, delete that import — `msg.turnMode` is already typed by the zod schema.

```bash
git add gateway/src/session-handlers/mic-echo-guard.ts gateway/src/session-handlers/session-voice-prefs.ts \
        gateway/src/session-handlers/ws-session-configure.ts gateway/src/runtime/session-runtime.ts \
        gateway/src/bootstrap/phase-services.ts gateway/src/bootstrap/create-gateway-services.ts
git commit -m "feat(gateway): fork native-loop deltas into TTS with per-session voice and echo suppression"
```

- [ ] **Step 21: Delete the stale references to purged modules.**

`gateway/src/tts/stages/stage-types.ts` — line 4-5, replace `Emitted by\n * the broadcaster when the LLM stops streaming text to call a tool` with:

```ts
 * Emitted by
 * the session's TurnVoice (runtime/turn-voice.ts) when the ReAct loop stops
 * streaming text to call a tool
```

`gateway/src/tts/streaming-tts-synthesizer.ts` — line 18, replace:

```ts
// The handler (speak-effect.ts) sees only frames in / frames out.
```

with:

```ts
// The caller (runtime/turn-voice.ts) sees only frames in / frames out.
```

`gateway/src/tts/text-stream-synthesizer.ts` — three sites:

- line 4: `// TextStreamSynthesizer — the swappable seam between the speak effect and` → `// TextStreamSynthesizer — the swappable seam between the turn's TTS fork and`
- line 11: `//     async iterator protocol — the consumer (speak-effect) controls pace.` → `//     async iterator protocol — the consumer (turn-voice) controls pace.`
- line 17: `// The speak-effect knows nothing about it.` → `// TurnVoice knows nothing about it.`

`gateway/config.yaml` — line 150, replace `# Echo-suppression cooldown (ms). On connector.audio.start, the mic is` with:

```yaml
  # Echo-suppression cooldown (ms). On turn.audio.start, the mic is
```

Nothing else in these files changes — comments only, no behaviour.

```bash
source scripts/env.sh && bun run lint && cd gateway/src && bun test
git add gateway/src/tts gateway/config.yaml
git commit -m "docs(gateway): retire purged-module references in the voice trees"
```

- [ ] **Step 22: Walk it against the local stack.**

The full matrix is Task 11/12's; this is the smoke that proves the seam is live before handing off.

```bash
source scripts/env.sh
docker compose -f deploy/macos/docker-compose.yml ps      # confirm nothing is holding :8888
bun run dev
```

With the local-stt and local-tts services up, open the webui, authenticate, toggle the mic, and speak one query. Confirm in `gateway/logs/$(date -u +%F).log`:

- `stt.connecting` → `stt.connected` with `turnMode`
- `stt.transcript.submit` with a non-zero `length`
- `session-runtime.turn.start`, then `turn-voice.begin`
- `turn-voice.audio.start` with `encoding: "opus"`, `sampleRate: 48000`, and a `firstFrameMs`
- `mic-suppress.tts-start` with `cooldownMs: 2500`
- `turn-voice.audio.done` with a non-zero `frameCount`

Then speak over the reply and confirm: `stt.barge-in` → `cancellation.abort` with `cutoff: "barge-in"` → `turn-voice.audio.cancelled` → `mic-suppress.cleared`, and **no** `turn-voice.audio.done` for that turn. No unexpected WARN/ERROR in the trail.

**E2E rows this task makes reachable** (owned by Tasks 11/12, listed here so the handoff is checkable): `voice-roundtrip`, `barge-in`, `steer-followup-audio`.

---

#### Residuals to carry into handover

- **STT reconnect is frame-driven.** The deleted `stt-reconnect-supervisor.ts` is not restored; a dropped STT socket re-dials on the next mic frame or the next `audio.start`. A session whose mic is closed when STT drops reconnects on the next `audio.start`, not sooner. No timers, no backoff constants, no new config — flagged as a deliberate simplification, not an oversight.
- **No client-type TTS policy.** The purged `tts-policy.ts` had a `cube` arm that spoke regardless of `ttsEnabled` (a headless device has no text surface). This task honours `profile.audio` uniformly. If the cube returns as a live surface, that arm comes back with it.
- **Voice prefs are read once per `session.configure`.** The 2.0 client→gateway contract has no preferences-patch frame, so there is nothing to hot-swap against; a settings change takes effect on the next connection.
