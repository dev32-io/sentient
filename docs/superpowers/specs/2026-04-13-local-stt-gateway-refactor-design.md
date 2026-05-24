# Local STT Gateway Refactor — Design

**Date**: 2026-04-13
**Status**: Draft — pending user review
**Scope**: Atomic refactor of `gateway/`, `shared/web-sdk/`, `shared/protocol/`, `shared/config/`, `gateway/webui/`, plus `deploy/pi/` and `deploy/docker/` wiring.

---

## 1. Overview

Replace Deepgram (Flux + Nova-3) with the already-deployed local STT service as the gateway's only speech-to-text source, and use that replacement as the catalyst for three simplifications that cannot land in isolation:

1. **STT adapter replaces STT provider.** A new `adapters/stt/local-stt-adapter.ts` with a four-method contract (`open`, `send`, `events`, `close`). Everything Deepgram-specific — VAD, endpointing, Smart-Turn confidence gating, partial transcripts, connection pool, silence-fill keepalive, transcript-timeout guards — is deleted.
2. **Pipeline contract tightens.** The gateway stops tracking partial transcripts, stops maintaining a pending-user draft, stops reconnecting STT per turn, and stops implementing a client-side barge-in path. Each was a Deepgram coping mechanism, not a business-logic requirement.
3. **Bootstrap layer replaces `main.ts` wiring.** Per-service factories in `src/bootstrap/` absorb today's sprawled init (especially the inline IIFE for TTS). `main.ts` becomes ~15 lines: load config → compose services → serve.

### 1.1 Atomic ship

Gateway + `@sentient/web-sdk` + `shared/protocol` + `shared/config` + `gateway/webui` move in one PR. The SDK's voice protocol shrinks to two new event types (`turn.started`, `turn.dropped`), `transcript.final` now carries rendered text, and client-side VAD primitives are removed entirely because the energy gate moves to the gateway.

### 1.2 Non-goals

No changes to: TTS stack (Fish Audio), sentence aggregator, emotion-tag processor, LLM streaming, persona loader semantics (only the file path + filename conventions change), auth session manager internals, or the PASETO-replacement shared-token model. No role-based login (still anonymous session per WS connect). No server-side support for `language: "multi"` (future; hard-coded `"en" | "zh"` for now).

---

## 2. Architecture

### 2.1 Top-level file layout (post-refactor)

```
gateway/
├── system_prompts/                             # NEW — all prompt text as data
│   ├── system_prompt.md                        # moved from gateway/system_prompt.md
│   ├── language-prompt-en.md                   # NEW
│   └── language-prompt-zh.md                   # NEW
├── persona.md                                  # stays at root
├── config.yaml                                 # new stt:/webui:-less shape
└── src/
    ├── main.ts                                 # ~15 lines: config → services → server
    ├── server.ts                               # ~50 lines: Bun.serve shell, GatewayServices injected
    ├── bootstrap/                              # NEW
    │   ├── create-gateway-services.ts          # composes all services
    │   ├── stt-factory.ts                      # creates the per-session LocalSttAdapter factory
    │   ├── tts-factory.ts                      # absorbs the main.ts IIFE
    │   ├── llm-factory.ts                      # tiny OpenRouter factory
    │   └── context-factory.ts                  # system prompt + assembler + emotion-tag opts
    ├── adapters/stt/                           # NEW (per user instruction, adapters/ NOT providers/)
    │   ├── local-stt-adapter.ts                # implements STTAdapter
    │   ├── stt-adapter-types.ts                # STTAdapter + STTEvent + STTAdapterConfig
    │   ├── wire-messages.ts                    # zod schemas for STT server→client frames
    │   ├── pause-renderer.ts                   # pure; [pause.N] + pauses[] → "[paused 1.2s]"
    │   ├── pcm-resampler.ts                    # pure; Int16 48k → 16k
    │   ├── energy-gate.ts                      # pure; normalized-RMS threshold
    │   └── token-loader.ts                     # reads gateway.yaml slot "gateway-stt"
    ├── pipeline/
    │   ├── continuous-session.ts               # 459 → ~140 lines, no emitter
    │   ├── turn-controller.ts                  # unchanged
    │   ├── voice-turn.ts                       # unchanged
    │   ├── turn-transition.ts                  # unchanged
    │   ├── turn-sink.ts                        # unchanged
    │   └── processors/                         # unchanged
    ├── providers/
    │   ├── tts/                                # unchanged
    │   └── openrouter.ts, llm-provider.ts      # unchanged
    ├── session-handlers/
    │   └── ws-handlers.ts                      # takes services arg, drops dead branches
    ├── context/
    │   ├── session-history.ts                  # strip draft/pending methods
    │   ├── context-assembler.ts                # unchanged
    │   └── system-prompt-loader.ts             # renamed from persona-prompt-loader.ts
    ├── config/
    │   └── startup-config.ts                   # drop Nova-3, swap Deepgram stt shape
    └── api/                                    # unchanged
```

### 2.2 Happy-path data flow (one voice-mode session)

```
User clicks "voice on" ──► webui sends audio.start
                               │
                               ▼
    ContinuousSession.start():
      parallel:
        - TTSConnectionManager.connect()        (Fish Audio)
        - STTAdapter.open()                     (local STT; one WS for whole session)
      await both → session ready
                               │
                               ▼
    User speaks → browser captures 48k PCM16 → webui streams binary frames continuously
                               │
                               ▼
    ContinuousSession.sendAudio(pcm) → LocalSttAdapter.send(pcm)
      inside send(): energy-gate → if passes: resample 48k→16k → ws.send
                               │
                               ▼
    STT fires vad_start (Silero) → adapter yields { type: "turn_started", turnIdx }
                               │
                               ▼
    ContinuousSession.handleEvent:
      - not speaking: sink.sendJson({ type: "turn.started", turnIdx })   → UI "..."
      - speaking:     executeBargeIn() → abort turn + TTS reconnect + barge_in.ack
                                         then sink.sendJson({ type: "turn.started", turnIdx })
                               │
                               ▼
    User finishes → internal Smart-Turn decides EOT → SenseVoice decodes
                               │
                               ▼
    STT fires transcript_ready → adapter renders pauses via language template
                              → yields { type: "transcript", turnIdx, text: "… [paused 1.2s] …" }
                               │
                               ▼
    ContinuousSession.handleEvent:
      sink.sendJson({ type: "transcript.final", turnIdx, text })
      history.append("user", text)
      createTurnController(...).run() → LLM stream → sentence aggregator → TTS
        dispatches response.text.delta, response.audio.start, response.audio.frame…, response.audio.done
                               │
                               ▼
    STT stays connected; next utterance starts another turn the same way
                               │
                               ▼
    User clicks "voice off" → webui sends audio.end
                               │
                               ▼
    ContinuousSession.close():
      - controller.abort()
      - activeTurn?.abort()
      - STTAdapter.close()
      - TTSConnectionManager.close()
      - await event-loop settle
```

### 2.3 Turn-dropped path

When local STT decides a turn was all noise (`turn_rejected`), the adapter yields `{ type: "turn_dropped", turnIdx }`. ContinuousSession forwards as `turn.dropped` — the webui clears the "..." placeholder without leaving a stuck UI state. No history append, no TurnController.

---

## 3. STT adapter internals

### 3.1 Public interface — `adapters/stt/stt-adapter-types.ts`

```ts
export interface STTAdapterConfig {
  readonly url: string;                     // ws://stt-service:8766
  readonly token: string;                   // loaded from gateway.yaml "gateway-stt"
  readonly language: "en" | "zh";           // drives pause renderer
  readonly inputSampleRate: number;         // 48000 (client capture rate)
  readonly energyThreshold: number;         // 0.0–1.0 normalized RMS; default 0.03
  readonly connectTimeoutMs: number;        // default 10000
}

export type STTEvent =
  | { readonly type: "turn_started"; readonly turnIdx: number }
  | { readonly type: "transcript"; readonly turnIdx: number; readonly text: string }
  | { readonly type: "turn_dropped"; readonly turnIdx: number };

export interface STTAdapter {
  open(signal: AbortSignal): Promise<void>;
  send(pcm: Uint8Array): void;
  events(signal: AbortSignal): AsyncGenerator<STTEvent>;
  close(): Promise<void>;
  setEnergyThreshold(t: number): void;      // future hook; immediate effect on next send()
}

export type STTAdapterFactory = (config: STTAdapterConfig) => STTAdapter;
```

### 3.2 `local-stt-adapter.ts` — wire implementation

Responsibilities:

- Open WS to `config.url` with `Authorization: Bearer <token>`.
- Await `{"type":"ready"}` (reject after `connectTimeoutMs`).
- Parse inbound text frames via zod schemas from `wire-messages.ts`. Binary WAV payloads are discarded silently.
- Translate STT wire events → `STTEvent`:
  - `vad_start` → `{ type: "turn_started", turnIdx }`
  - `transcript_ready` → `renderPauses(text, pauses, language)` → `{ type: "transcript", turnIdx, text: rendered }`
  - `turn_rejected` → `{ type: "turn_dropped", turnIdx }`
  - Everything else (`vad_end`, `smart_turn_eval`, `turn_continuing`, `turn_complete`, `warning`, `pong`, `ready` after the first) — log at DEBUG, drop.
- `send(pcm)`:
  ```
  if (!acceptEnergy(pcm, threshold)) return;        // drop silent frame
  const downsampled = downsamplePcm16(pcm, inputRate, 16000);
  if (ws.readyState === OPEN) ws.send(downsampled);
  ```
- Queue events into an internal `EventQueue` (same pattern as today's `flux-provider.ts` used for its own queue); `events(signal)` is an AsyncGenerator that pulls from the queue and respects abort.
- `close()`: idempotent; sets disposed flag, resolves pending waiter with `null` to terminate generator, sends a graceful WS close frame.
- WS unexpected-close / error: terminate generator, INFO-log reason. Caller does not reopen — voice session is over.

Logger: `["sentient", "stt"]`. INFO: `ws-opening`, `ws-ready`, `ws-closed`, `turn-started (turnIdx)`, `transcript (turnIdx, length)`, `turn-dropped (turnIdx)`, `connect-failed`. DEBUG: every wire event before/after translation, plus a throttled "send — dropped/forwarded" per N frames.

Target: ~180 lines.

### 3.3 `wire-messages.ts`

Zod schemas for only the text frames we consume; unknown fields stripped. Schemas for `ready`, `vad_start`, `transcript_ready`, `turn_rejected`. All wrapped in one `sttServerMessageSchema = z.discriminatedUnion("type", [...])`. Parse failures log WARN and drop.

### 3.4 `pause-renderer.ts` — pure function

```ts
export function renderPauses(
  text: string,
  pausesMs: readonly number[],
  language: "en" | "zh",
): string;
```

- `en`: `[paused 1.2s]` (rounded to one decimal; `>= 10s` round to integer seconds; `< 0.1s` rounds to `0.1s`).
- `zh`: `[停顿 1.2秒]` (same rounding rules).
- Preserves surrounding whitespace.
- Invariant from CONTRACT §5.2: `pausesMs.length` should equal the `[pause.N]` count. On mismatch, log WARN, replace what can be replaced in order, leave any remaining placeholders intact. Never throw.

### 3.5 `pcm-resampler.ts` — pure function

```ts
export function downsamplePcm16(
  input: Uint8Array,
  inputRate: number,
  outputRate: number,
): Uint8Array;
```

Linear interpolation, same algorithm as today's `audio-stream-handler.ts` (which is deleted). When `inputRate === outputRate`, returns input unchanged.

### 3.6 `energy-gate.ts` — pure function

```ts
export function energyRmsNormalized(pcm: Uint8Array): number;  // 0.0–1.0
export function acceptEnergy(pcm: Uint8Array, thresholdRms: number): boolean;
```

RMS over normalized `[-1, 1]` float samples, interpreted from the Int16 little-endian PCM bytes.

### 3.7 `token-loader.ts`

```ts
export function loadGatewayOutboundToken(
  tokensFile: string,          // default "/app/tokens.yaml" (the container mount)
  slot: "gateway-stt",
): string;
```

Parses the YAML with a zod schema matching `sentient-auth/src/tokens.ts` (six-line `TokensFileSchema` duplicated rather than imported — no new cross-package dependency for a tiny schema). Throws loudly on missing file, missing slot, or malformed YAML with an actionable one-liner: "run `sentient-auth init` / ensure `/app/tokens.yaml` is mounted".

Called once in `stt-factory.ts`; cached by the factory.

Logger: `["sentient", "auth", "token-loader"]`. INFO: `token-loaded` (fingerprint only, never the token). WARN/ERROR on any failure path, with the offending path.

### 3.8 Language hint via system_prompts

The gateway never normalizes misdetected SenseVoice output — the LLM handles interpretation via a language hint in the system prompt.

Files:
- `gateway/system_prompts/system_prompt.md` — moved from `gateway/system_prompt.md`.
- `gateway/system_prompts/language-prompt-en.md` — NEW. Tells the LLM the user speaks English; treat short foreign-looking sounds as backchannel; reply in English.
- `gateway/system_prompts/language-prompt-zh.md` — NEW. Equivalent in Chinese.
- `gateway/persona.md` — stays at gateway root.

Loader rename: `src/context/persona-prompt-loader.ts` → `src/context/system-prompt-loader.ts`.

```ts
export function loadSystemPrompt(opts: {
  language: "en" | "zh";
  personaFile?: string;              // defaults to "persona.md"
  runtimeDir?: string;               // defaults to GATEWAY_RUNTIME_DIR env or derived
}): string;
```

Concatenates in order, separated by `"\n\n"`, skipping missing files with WARN logs:
1. `system_prompts/system_prompt.md`
2. `system_prompts/language-prompt-<language>.md`
3. `<personaFile>` at gateway root.

If all three missing → falls back to a DEFAULT_PERSONA constant.

Dockerfile change: the current `COPY system_prompt.md` line becomes `COPY system_prompts/ /app/system_prompts/` plus the existing `COPY persona.md`.

### 3.9 Testing

- `pause-renderer.test.ts`: both languages, zero pauses, many pauses, mismatched counts, boundary durations.
- `pcm-resampler.test.ts`: identity, 48→16 correctness (sample count + endianness), empty input.
- `energy-gate.test.ts`: silence (0), full-scale square (≈1.0), sine wave, threshold sweep.
- `token-loader.test.ts`: valid file, missing file, missing slot, malformed YAML.
- `wire-messages.test.ts`: every schema parses its documented example; malformed rejected.
- `local-stt-adapter.test.ts` (against a mocked WebSocket):
  - `open()` resolves after `ready`.
  - `open()` rejects on timeout.
  - `open()` rejects on 401-then-close.
  - `events()` yields `turn_started` on `vad_start`.
  - `events()` yields `transcript` with rendered text on `transcript_ready`.
  - `events()` yields `turn_dropped` on `turn_rejected`.
  - `events()` skips `vad_end`, `smart_turn_eval`, `turn_continuing`, `turn_complete`, binary, unknown, malformed.
  - `send()` drops silent PCM; forwards loud PCM downsampled to 16k; drops when WS not OPEN.
  - Abort mid-events terminates generator cleanly.
  - `close()` idempotent.
- `system-prompt-loader.test.ts`: all 4 permutations of file present/missing × language en/zh; all-missing → DEFAULT_PERSONA.

---

## 4. ContinuousSession + bootstrap

### 4.1 ContinuousSession — rewrite

Current: 459 lines, event emitter, per-turn STT reconnect, inactivity monitor, barge-in controller, partial-transcript accumulation. Target: ~140 lines, no emitter.

**New interface**:

```ts
export interface ContinuousSession {
  start(): Promise<void>;
  sendAudio(audio: Uint8Array): void;
  close(): Promise<void>;
  isConnected(): boolean;
}
```

**Lifecycle**:

```ts
async start() {
  adapter = sttAdapterFactory(sttAdapterConfig);
  await Promise.all([
    ttsConnectionManager.connect(),
    adapter.open(controller.signal),
  ]);
  eventLoopPromise = runEventLoop();
}
```

**Event loop**:

```ts
for await (const event of adapter.events(controller.signal)) {
  switch (event.type) {
    case "turn_started":
      if (activeTurn?.isAssistantSpeaking()) {
        await executeBargeIn();    // abort, reconnect TTS, barge_in.ack
      }
      sink.sendJson({ type: "turn.started", turnIdx: event.turnIdx });
      break;
    case "transcript":
      sink.sendJson({ type: "transcript.final", turnIdx: event.turnIdx, text: event.text });
      history.append("user", event.text);
      startTurn(event.text);
      break;
    case "turn_dropped":
      sink.sendJson({ type: "turn.dropped", turnIdx: event.turnIdx });
      break;
  }
}
```

`executeBargeIn()` delegates to the existing `TurnTransition` (`turn-transition.ts`) unchanged.

**Deleted from the session**: `connectSTT/disconnectSTT`, `earlyAudioBuffer`, `sttConnectPromise/sttConnected/sttController`, `startInactivityMonitor/stopInactivityMonitor/checkInactivity`, `startTranscriptRelay`, `handleTranscriptEvent`, the barge-in controller field and its event handling, `speechStartEmitted`, every `emitter.emit(...)` call and the emitter itself, `bargeIn()` public method, `warmup/dispose` hooks.

**Kept**: `startTurn(transcript)`, `executeBargeIn()`, `sendAudio(pcm)`, `close()`.

### 4.2 `SessionHistory` — strip draft methods

Delete: `setDraft`, `pendingUserText`, `hasPendingUserSpeech`, `finalizePendingUser`, `clearDraft`, and all their internal state. Keep: `append(role, text)`, `messages()`, `clear()`. File shrinks from ~245 to ~130 lines; its tests lose the half that tested drafts.

### 4.3 `continuous-voice-handler.ts` — shrink or fold

Its entire `wireSessionEvents()` block deletes (no more event forwarding). The remaining `handleContinuousStart` / `handleContinuousEnd` pair is thin; fold into `ws-handlers.ts` and delete the file.

### 4.4 `ws-handlers.ts` — trim

Takes `services: GatewayServices` instead of the 10-field options bag. Delete branches:
- `msg.type === "auth"` (already dead — session opens on WS connect).
- `msg.type === "barge_in"` (no client-initiated barge-in).
- `msg.type === "utterance.start" | "utterance.end" | "utterance.cancel"` (never wired).
- `msg.type === "guest.auth"` (PASETO gone).
- `msg.type === "session.start"` (unused).

Keep: `session.configure`, `audio.start`, `audio.end`, `text.input`, `session.end`, `ping`, `tool.confirm`.

### 4.5 Bootstrap factories

All in `src/bootstrap/`.

`llm-factory.ts` (~15 lines):
```ts
export function createLlmService(cfg: StartupConfig): LLMProvider | null {
  if (!cfg.llm) return null;
  return createOpenRouterProvider({ apiKey: cfg.llm.apiKey, baseUrl: OPENROUTER_BASE_URL, siteName: "Sentient" });
}
```

`stt-factory.ts` (~30 lines):
```ts
export interface SttService {
  readonly adapterFactory: STTAdapterFactory;
  readonly adapterConfig: STTAdapterConfig;
}

export function createSttService(cfg: StartupConfig): SttService {
  const token = loadGatewayOutboundToken(cfg.stt.tokensFile, "gateway-stt");
  return {
    adapterFactory: createLocalSttAdapter,
    adapterConfig: {
      url: cfg.stt.url,
      token,
      language: cfg.language,
      inputSampleRate: cfg.stt.input_sample_rate,
      energyThreshold: cfg.stt.energy_threshold,
      connectTimeoutMs: cfg.stt.connect_timeout_ms,
    },
  };
}
```

`tts-factory.ts` (~40 lines) absorbs the current `ttsSetup` IIFE in `main.ts`. Returns `{ connectionManager, processorFactory } | null`.

`context-factory.ts` (~30 lines) loads the system prompt via the renamed loader, builds the context assembler, builds emotion-tag options (same logic as today, isolated).

`create-gateway-services.ts` (~40 lines) composes everything:

```ts
export interface GatewayServices {
  readonly sessionManager: SessionManager;
  readonly context: ContextServices;
  readonly llmProvider: LLMProvider | null;
  readonly stt: SttService | null;
  readonly tts: TtsService | null;
  readonly chatModel: string;
  readonly language: "en" | "zh";
  readonly tls: GatewayTlsMaterial | undefined;
  readonly webDistDir: string | undefined;
}

export function createGatewayServices(cfg: StartupConfig): GatewayServices { /* ... */ }
```

### 4.6 `main.ts` — target ~15 lines

```ts
const loggingConfig = loadLoggingConfig();
await createGatewayLogger({ ...(loggingConfig.logLevel ? { logLevel: loggingConfig.logLevel } : {}), enableFile: true, logDir: loggingConfig.logDir });

const log = getLog(["sentient"]);
const config = loadStartupConfig();
const services = createGatewayServices(config);
const server = createGatewayServer({ port: config.port, host: config.host, services });
log.info("gateway-started", { host: server.hostname, port: server.port });
export { server };
```

"Missing API key" warnings move into the relevant factories.

### 4.7 `server.ts` — target ~50 lines

Takes `GatewayServerOptions { port, host, services }`. Wires `Bun.serve<ClientData>`'s `fetch`/`websocket.open`/`message`/`close` to router + `openSession` + `handleWebSocketMessage` + cleanup. Each handler receives `services` from the injected container.

---

## 5. SDK, webui, wire protocol

### 5.1 Wire protocol — final shape

**Client → Server (kept)**: `session.configure`, `audio.start`, `audio.end`, `text.input`, `session.end`, `ping`, `tool.confirm`.

**Client → Server (dropped)**: `auth` (dead branch), `barge_in` (server-driven now), `utterance.start/end/cancel` (never wired), `guest.auth` (PASETO gone), `session.start` (unused).

**Server → Client (kept)**: `auth.ok`, `session.ready`, `transcript.final` (now carries rendered text), `response.start`, `response.text.delta`, `response.text.done`, `response.audio.start`, `response.audio.done`, `barge_in.ack`, `tool.confirm_request`, `error`, `pong`, `session.expired`.

**Server → Client (dropped)**: `transcript.partial`, `vad.speech-start`, `vad.speech-end`, `status.processing` (redundant with `turn.started`).

**Server → Client (new)**:

```ts
export const turnStartedSchema = z.object({
  type: z.literal("turn.started"),
  turnIdx: z.number().int().min(1),
});

export const turnDroppedSchema = z.object({
  type: z.literal("turn.dropped"),
  turnIdx: z.number().int().min(1),
});
```

`transcriptFinalSchema` becomes `{ type, turnIdx, text }` (drops `utteranceId`).

### 5.2 SDK (`@sentient/web-sdk`)

**Deleted files**: `energy-vad-filter.ts` + test, `preroll-buffer.ts`, `trailing-vad-filter.ts` + test, `vad-filter.ts` + test, `transcript-accumulator.ts` + test.

**Edited files**:
- `voice-client.ts` — drop `vadPreFilter` constructor option; audio flows directly from capture to transport.
- `ws-speech-service.ts` — drop `transcript.partial`/`vad.*`/`status.processing` handlers; add `turn.started` → fires `turnStarting`, `turn.dropped` → fires `turnDropped`.
- `speech-service.ts` — interface shrink: drop `onTranscriptPartial/onVadSpeechStart/onVadSpeechEnd`; add `onTurnStarting/onTurnDropped`.
- `voice-state-machine.ts` — transitions: `turn.started` → `userSpeaking`, `transcript.final` → `thinking`, `response.audio.start` → `assistantSpeaking`, `response.audio.done` → `idle`, `turn.dropped` → `idle`.
- `message-store.ts` — on `turn.started` append a user placeholder (`"..."`); on `transcript.final` replace placeholder text with rendered transcript; on `turn.dropped` remove the placeholder.
- `index.ts` — stop re-exporting deleted primitives.

### 5.3 WebUI (`gateway/webui`)

- `use-voice-client.ts` drops `vadPreFilter` wiring.
- Chat bubble rendering uses the new placeholder-replace flow from the SDK (no webui-local code change beyond the hook).
- `constants.ts` unchanged — no new entries.
- No new env vars, no new fetch, no new endpoint.

### 5.4 Docker-compose + setup.sh

`deploy/pi/docker-compose.yml` — gateway service gains:

```yaml
- type: bind
  source: ~/.sentient/auth/tokens/gateway.yaml
  target: /app/tokens.yaml
  read_only: true
  bind:
    create_host_path: false
```

`deploy/docker/docker-compose.yml` — same edit applied (Mac-local dev stack must also mount the tokens file).

`deploy/pi/setup.sh` and `deploy/local/setup.sh` — ensure `~/.sentient/auth/tokens/gateway.yaml` exists, fail loudly with a hint to run `sentient-auth init` if missing.

`DEEPGRAM_API_KEY` removed from `.env.example` and any referencing docs.

Gateway `config.yaml` comments document the STT URL: in Pi compose it's `ws://stt-service:8766`; local-dev override via env or `stt.url` edit.

### 5.5 Config schema changes

`shared/config/src/schema.ts`:
- Delete `sttNova3ConfigSchema`.
- Rewrite `sttConfigSchema`:

```ts
export const sttConfigSchema = z.object({
  provider: z.literal("local-stt"),
  url: z.string().default("ws://stt-service:8766"),
  language: z.enum(["en", "zh"]).default("en"),
  input_sample_rate: z.number().int().min(8000).default(48000),
  energy_threshold: z.number().min(0).max(1).default(0.03),
  connect_timeout_ms: z.number().int().min(1000).default(10000),
  tokens_file: z.string().default("/app/tokens.yaml"),
});
```

`gateway/config.yaml` — replace `stt:` + `stt_nova3:` blocks with the new `stt:` block. Inline comments document: what the url should be in Pi vs local-dev, acceptable range for `energy_threshold`, what `tokens_file` expects.

`gateway/src/config/startup-config.ts`:
- Drop `deepgramApiKey` reading.
- Drop `sttNova3` field on StartupConfig.
- Rewrite `stt` StartupConfig entry around the new schema shape.
- `language` moves up to a top-level StartupConfig field sourced from `stt.language` (so other modules read it without going through `stt`).

### 5.6 Tests

- `shared/protocol/messages.test.ts` — add `turn.started`, `turn.dropped`, updated `transcript.final`. Remove deleted types.
- `shared/config/schema.test.ts` — validate the new `stt` block; reject legacy shape with a clear error.
- SDK tests: delete tests for removed files; add `ws-speech-service.test.ts` cases; update `message-store.test.ts`, `voice-state-machine.test.ts`.
- Bootstrap factory tests: one per factory + one for the composer.
- ContinuousSession test rewrite: fake STTAdapter + scripted events; assert sink messages + TurnController invocation.
- `pipeline/__tests__/continuous-session.integration.test.ts` rewired against the fake adapter.

---

## 6. Rollout & definition of done

### 6.1 Commit sequencing inside the PR

1. Shared contracts (`shared/protocol`, `shared/config`).
2. New STT adapter + pure helpers (no consumers yet).
3. System prompt refactor (move file, add language prompts, rename loader).
4. Bootstrap factories (drop-in; `main.ts` starts using the composer).
5. ContinuousSession rewrite + SessionHistory trim + delete barge-in-controller.
6. ws-handlers / continuous-voice-handler trim.
7. Delete Deepgram providers + `audio-stream-handler.ts`.
8. SDK shrink.
9. WebUI rewire.
10. Docker-compose + setup.sh + `.env.example`.
11. Dockerfile `COPY` path update for `system_prompts/`.
12. Docs (`gateway/README.md`, root CLAUDE.md references).

Per the "skip broken tests during refactor" memory: if mid-refactor commits leave unrelated tests red, fix once at the end with a note in the final commit — don't interleave test-fix commits.

Per the "don't change tuned constants" memory: TTS chunk/latency/idle/stop timeouts stay exactly as configured. Only `stt.*` values change.

### 6.2 Definition of done

The task is not done until:

1. **Local build passes** — `cd deploy/docker && docker compose build` completes cleanly for every service image.
2. **Stack starts clean** — `docker compose up -d` brings up gateway, stt-service, sentient-auth (if any step needs fresh tokens). All containers report healthy. No startup errors in logs.
3. **Token provisioning** — if `~/.sentient/auth/tokens/gateway.yaml` is missing or its `gateway-stt` slot is stale, I provision it myself by building and running `sentient-auth` locally (`cd sentient-auth && ./run.sh init` or `./run.sh rotate gateway-stt`). `~/.sentient/` is free to read and modify for local-stack bootstrapping; `.env*` and `~/.zshrc` remain off-limits.
4. **Real exercise against the running stack** — browser open to the webui against local compose; toggle voice on; speak an English utterance; verify:
   - `turn.started` "..." bubble appears.
   - `transcript.final` replaces it with rendered text (including `[paused Ns]` where present).
   - Assistant audio + text response streams back.
   - Speak during assistant response → verify `barge_in.ack`, TTS cuts, new turn processes.
   - Produce a deliberately noisy non-speech burst → verify `turn.dropped` clears the bubble.
   - Toggle voice off; verify STT + TTS close in container logs.
   - Flip `language: zh` in config, restart, repeat in Chinese — verify the ZH language prompt is loaded (log line) and the ZH pause renderer fires.
5. **Log inspection** —
   - `docker logs sentient-gateway` — no unhandled errors; expected INFO lifecycle lines visible.
   - `docker logs sentient-stt-service` — `auth.accept caller=gateway`; per-turn VAD/Smart-Turn/SenseVoice lifecycle visible; no auth rejections.
   - `~/.sentient/gateway/logs/*.log` — INFO lines from §6.3 below appear with `sessionId`, `turnIdx`.
6. **Any error found is fixed** and steps 1–5 re-run. If a Pi-only behavior cannot be exercised locally (macOS vs ARM64 STT model difference), that is stated explicitly in the PR — never skipped silently.

### 6.3 Logging coverage inventory

Every new file imports `getLog` with a hierarchical tag. Guaranteed INFO lines:

- `sentient.stt`: `ws-opening`, `ws-ready`, `turn-started (turnIdx)`, `transcript (turnIdx, length)`, `turn-dropped (turnIdx)`, `ws-closed`, `connect-failed`.
- `sentient.session`: `session-start`, `session-ready`, `start-turn (turnIdx)`, `barge-in-execute`, `turn-dropped-forwarded`, `session-close`.
- `sentient.bootstrap`: `services-composed` (list of enabled services), `service-disabled` (per missing config/secret).
- `sentient.auth.token-loader`: `token-loaded` (fingerprint only), `token-missing`, `token-slot-not-found`.
- `sentient.context.system-prompt`: `system-prompt-loaded`, `language-prompt-loaded`, `persona-loaded`, and `-missing` counterparts.

DEBUG: per-chunk audio trace (throttled), every STT wire event before/after translation.

### 6.4 Full deletions inventory

**Source files deleted**:

- `gateway/src/providers/stt/flux-provider.ts` + 3 tests (`flux-provider.test.ts`, `flux-provider-connection.test.ts`, `flux-provider-streaming.test.ts`)
- `gateway/src/providers/stt/nova3-provider.ts` + `nova3-provider.test.ts`
- `gateway/src/providers/stt/stt-factory.ts` + test
- `gateway/src/providers/stt/stt-types.ts` + test
- `gateway/src/providers/stt/audio-stream-handler.ts`
- `gateway/src/pipeline/barge-in-controller.ts` + `barge-in-controller.test.ts` + `barge-in-integration.test.ts`
- `shared/web-sdk/src/energy-vad-filter.ts` + test
- `shared/web-sdk/src/preroll-buffer.ts`
- `shared/web-sdk/src/trailing-vad-filter.ts` + test
- `shared/web-sdk/src/vad-filter.ts` + test
- `shared/web-sdk/src/transcript-accumulator.ts` + test

**Source files renamed**:
- `gateway/src/context/persona-prompt-loader.ts` → `gateway/src/context/system-prompt-loader.ts` (+ corresponding test)
- `gateway/system_prompt.md` → `gateway/system_prompts/system_prompt.md`

**Source files created**:
- `gateway/system_prompts/language-prompt-en.md`
- `gateway/system_prompts/language-prompt-zh.md`
- `gateway/src/adapters/stt/{local-stt-adapter,stt-adapter-types,wire-messages,pause-renderer,pcm-resampler,energy-gate,token-loader}.ts` + tests (except for the types file)
- `gateway/src/bootstrap/{create-gateway-services,stt-factory,tts-factory,llm-factory,context-factory}.ts` + tests

**Source files heavily edited**:
- `gateway/src/main.ts` (121 → ~15 lines)
- `gateway/src/server.ts` (68 → ~50 lines)
- `gateway/src/pipeline/continuous-session.ts` (459 → ~140)
- `gateway/src/pipeline/continuous-session.test.ts` (rewritten)
- `gateway/src/session-handlers/ws-handlers.ts` (drop dead branches; take `services` arg)
- `gateway/src/session-handlers/continuous-voice-handler.ts` (folded into ws-handlers or shrunk)
- `gateway/src/context/session-history.ts` (~245 → ~130, drop draft methods)
- `gateway/src/context/session-history.test.ts` (drop draft tests)
- `gateway/src/config/startup-config.ts` (rewrite stt, drop Nova-3, drop DEEPGRAM_API_KEY read)
- `gateway/config.yaml` (rewrite stt:, drop stt_nova3:)
- `shared/config/src/schema.ts` (rewrite sttConfigSchema, drop sttNova3ConfigSchema)
- `shared/protocol/src/messages.ts` (per §5.1)
- `shared/web-sdk/src/{voice-client,ws-speech-service,speech-service,voice-state-machine,message-store,index}.ts`
- `gateway/webui/src/hooks/use-voice-client.ts`
- `gateway/webui/src/App.tsx` (or equivalent, for chat bubble flow)
- `deploy/pi/docker-compose.yml`, `deploy/docker/docker-compose.yml`
- `deploy/pi/setup.sh`, `deploy/local/setup.sh`
- `gateway/Dockerfile` (copy `system_prompts/` directory)

**Env vars removed**: `DEEPGRAM_API_KEY` from all docs, `.env.example`, and `startup-config.ts`.

---

## 7. Open questions

None. The design has been validated section-by-section with the user.

---

## 8. References

- `capabilityServices/STTService/CONTRACT.md` — wire protocol for the local STT service.
- `.claude/rules/pipeline.md` — decorator-unit rules the adapter + pipeline obey.
- `.claude/rules/clean-code.md` — file/function/nesting limits used to size targets.
- `.claude/rules/config.md` — configuration-as-data rule driving the new `stt:` block.
- `.claude/rules/logging.md` — logger tag hierarchy used in §6.3.
- `sentient-auth/` — tokens file layout consumed by the new token-loader.
- Memory: "Verify against real containers before done", "Never read .env or .zshrc", "Don't change tuned constants", "Skip broken tests during refactor", "Don't preserve stale references".
