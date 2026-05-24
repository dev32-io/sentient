# Provider Integration — TypeScript

## Decision Area
TypeScript interfaces and streaming patterns for STT, LLM, and TTS provider integration on Bun runtime (RPi5).

## Key Questions
- TypeScript interface design for provider contracts (STT, LLM, TTS)?
- Streaming patterns: async iterators vs ReadableStream vs EventEmitter?
- Fish Audio TTS: WebSocket streaming, Opus output, emotion tags?
- Deepgram STT: WebSocket streaming, partial transcripts, speech_final?
- OpenRouter LLM: SSE streaming, function calling, model selection?
- Provider failover: config-ordered with circuit breaker pattern?
- Configuration: YAML for structure, env vars for secrets?
- npm ecosystem: existing TypeScript SDKs for each provider?
- Streaming overlap: TTS starts on first sentence while LLM still generating?
- Error handling: provider timeout, rate limiting, graceful degradation?

## Approaches

### Approach A: Unified AsyncGenerator Interface with Raw Connections
All providers expose `AsyncGenerator<T>` interfaces. Use raw WebSocket for STT/TTS (avoiding SDK Bun incompatibilities), OpenAI SDK for LLM. Cockatiel for resilience.

### Approach B: ReadableStream/TransformStream Pipeline (Web Streams)
Leverage Bun-native Web Streams API. Each provider wraps as ReadableStream, compose via `.pipeThrough()`. More "platform-native" but heavier abstraction.

### Approach C: EventEmitter Pattern (Node-style)
Traditional Node.js event-driven approach. Familiar but no backpressure, weaker typing, harder to compose.

## Prior Research
- `2026-04-02-voice-gateway/` — detailed provider research (Fish Audio, Deepgram, OpenRouter)
- Python iteration used Protocol classes — translate to TS interfaces
- Provider failover with circuit breaker pattern from prior research

---

## Findings

### Provider-Specific Integration Details

#### Deepgram STT (Cloud Primary)
- **SDK Status**: `@deepgram/sdk` v5.0.0 — **NOT recommended for Bun**. Known binary frame issues with Bun's WebSocket client (#3742, #6686, #21807). Continuation frames not always reassembled correctly.
- **Recommended**: Raw WebSocket (~100 lines of code)
  - Connect to `wss://api.deepgram.com/v1/listen?encoding=opus&sample_rate=48000&channels=1`
  - Send binary audio frames (ArrayBuffer), receive JSON transcript messages
  - Send `{"type": "KeepAlive"}` to prevent 10-second idle timeout
  - **MUST** set `binaryType = "arraybuffer"` — `"blob"` crashes Bun
- **Key events for endpointing**:
  - `is_final: true` — maximum accuracy reached for segment
  - `speech_final: true` — endpointing detected pause in speech (primary trigger)
  - `UtteranceEnd` — separate message type for long gaps, enabled via `utterance_end_ms=1000`
  - Strategy: trigger on `speech_final`, use `UtteranceEnd` as fallback safety net
- **Streaming partials**: Interim transcripts arrive every ~100ms for responsive UI feedback

#### OpenRouter LLM
- **SDK Choice**: OpenAI SDK with `baseURL: "https://openrouter.ai/api/v1"` — simplest, best documented, avoids fragmentation in `@openrouter/sdk` (which split tool calling into `@openrouter/agent`)
- **SSE streaming**: `fetch()` with `for await (const chunk of response.body)` in Bun — works well
- **Function/tool calling**: Fully supported, passed through to providers implementing OpenAI interface
- **Model flexibility**: Route to different models per intent class:
  - Classifier: Haiku 4.5 ($0.80/$4.00 per 1M) — cheapest, fast enough for classification
  - Conversation: Sonnet 4.6 — balanced cost/quality
  - Complex reasoning: Opus 4.6 ($5/$25 per 1M) — reserved for skill-driven tasks
- **Streaming overlap**: First sentence detection in stream → fire TTS immediately while LLM continues

#### Fish Audio TTS
- **SDK**: `fish-audio-sdk` v0.1.0 — very new, risky with Bun's binary frame issues
- **Recommended**: Raw WebSocket + `@msgpack/msgpack` for MessagePack serialization
  - WSS endpoint with MessagePack binary protocol
  - Client sends: `StartEvent` (config), `TextEvent` (text chunks), `FlushEvent` (force synthesis), `CloseEvent`
  - Server sends: `AudioEvent` (audio chunks), `FinishEvent`
  - Auth: `Authorization: Bearer <key>` header
- **Opus output**: Supported at 48kHz, bitrates: auto/24/32/48/64 kbps. 48kbps ideal for voice — low bandwidth, good quality
- **Latency modes**: `normal` (best quality), `balanced`, `low` (lowest latency) — use `balanced` for voice gateway
- **Models**: `speech-1.5` (default), `speech-1.6`, `agent-x0`
- **Streaming TTS**: Send text chunks as they arrive from LLM → Fish Audio synthesizes incrementally → stream Opus back to client. This is the critical path for latency.

### Streaming Pattern Analysis

#### Approach A: AsyncGenerator (Recommended)

```typescript
// Unified provider interfaces
interface STTProvider {
  connect(config: STTConfig): Promise<STTSession>;
}
interface STTSession {
  send(audio: ArrayBuffer): void;
  transcripts(): AsyncGenerator<Transcript>;
  close(): Promise<void>;
}

interface LLMProvider {
  stream(messages: Message[], tools?: Tool[]): AsyncGenerator<LLMChunk>;
}

interface TTSProvider {
  connect(config: TTSConfig): Promise<TTSSession>;
}
interface TTSSession {
  synthesize(text: AsyncGenerator<string>): AsyncGenerator<ArrayBuffer>;
  close(): Promise<void>;
}
```

**Why AsyncGenerator**:
- Native TypeScript, zero abstraction overhead
- Pull-based: consumer controls pace → natural backpressure
- Composable: `for await...of` chains trivially
- Bun supports async iteration on ReadableStream and WebSocket
- Maps cleanly to the pipeline: `STT → Classifier → LLM → Sentence Splitter → TTS → Client`
- Easy to cancel via `generator.return()` for barge-in propagation

**Streaming overlap with AsyncGenerator**:
```typescript
// LLM generates text → sentence splitter yields complete sentences → TTS synthesizes each
async function* sentenceSplit(llmStream: AsyncGenerator<LLMChunk>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of llmStream) {
    buffer += chunk.text;
    const sentences = extractCompleteSentences(buffer);
    for (const sentence of sentences.complete) {
      yield sentence;  // TTS starts immediately on first sentence
    }
    buffer = sentences.remainder;
  }
  if (buffer.trim()) yield buffer;
}
```

#### Approach B: Web Streams (ReadableStream/TransformStream)

```typescript
// Pipeline composition via pipe
sttStream
  .pipeThrough(classifierTransform)
  .pipeThrough(llmTransform)
  .pipeThrough(sentenceSplitTransform)
  .pipeThrough(ttsTransform)
  .pipeTo(clientSink);
```

- More "platform standard" and composable via `.pipeThrough()`
- Built-in backpressure via queuing strategy
- **Drawback**: TransformStream is verbose to implement (controller push/pull API)
- **Drawback**: Error handling across pipe chains is awkward
- **Drawback**: Cancel propagation through pipe chain requires `.cancel()` on every stage
- **Bun caveat**: ReadableStream used as Response body may batch chunks (#13923), though not an issue when consuming streams as client

#### Approach C: EventEmitter Pattern

- Familiar to Node.js devs, trivial to implement
- **Drawback**: No backpressure — fast producer overwhelms slow consumer
- **Drawback**: Weak typing (`on("data", callback)` loses type info without wrapper)
- **Drawback**: Harder to compose — requires manual plumbing between emitters
- **Drawback**: Memory leak risk from unremoved listeners
- **Not recommended** for this use case

### Resilience: Circuit Breaker + Failover

**Library**: `cockatiel` v3.2.1 — zero dependencies, pure TypeScript, Bun-compatible
- Composable policies: Retry → Circuit Breaker → Timeout
- Wrap each provider call in a policy chain

**Failover strategy** (config-ordered):
```yaml
# config/providers.yaml
stt:
  providers:
    - name: deepgram
      type: cloud
      priority: 1
      config:
        api_key: ${DEEPGRAM_API_KEY}
        model: nova-3
    - name: whisper-local
      type: local
      priority: 2
      config:
        model: base.en-q5_0

tts:
  providers:
    - name: fish-audio
      type: cloud
      priority: 1
      config:
        api_key: ${FISH_AUDIO_API_KEY}
        model: speech-1.5
        latency_mode: balanced

llm:
  default_model: anthropic/claude-sonnet-4-6
  classifier_model: anthropic/claude-haiku-4-5
  providers:
    - name: openrouter
      type: cloud
      priority: 1
      config:
        api_key: ${OPENROUTER_API_KEY}
```

**Circuit breaker behavior**:
- Open after 5 consecutive failures (STT) or 3 failures (TTS/LLM)
- Half-open test after 30 seconds
- On open: fail over to next provider in config order
- For STT: Deepgram fails → whisper.cpp local fallback
- For TTS: Fish Audio fails → queue responses as text-only (graceful degradation)
- For LLM: OpenRouter fails → no fallback (hard dependency), but retry with exponential backoff

### Configuration

**Library**: `yaml` v2.8.1 — zero dependencies, built-in TypeScript types, YAML 1.2 spec

**Pattern**: YAML for structure, environment variables for secrets (referenced via `${VAR}` syntax, resolved at load time)

```typescript
// config/loader.ts
import { parse } from "yaml";
import { readFileSync } from "fs";

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => {
      const val = process.env[key];
      if (!val) throw new Error(`Missing env var: ${key}`);
      return val;
    });
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, resolveEnvVars(v)])
    );
  }
  return obj;
}

export function loadConfig(path: string): Config {
  const raw = parse(readFileSync(path, "utf8"));
  return resolveEnvVars(raw) as Config;
}
```

### Bun-Specific Concerns

| Concern | Status | Mitigation |
|---------|--------|------------|
| WebSocket binary frame fragmentation | Open issues (#3742, #6686, #21807) | Use `binaryType = "arraybuffer"` always; test with actual payload sizes |
| `ws.ping()` not implemented | Open (#3202) | Implement application-level keepalive (Deepgram's `KeepAlive` JSON, Fish Audio heartbeat) |
| `permessage-deflate` | Supported since v1.2.18 | Enable for JSON messages, skip for already-compressed audio |
| ReadableStream chunk batching | Discussion #13923 | Only affects server-side SSE emission, not client consumption |
| N-API (for onnxruntime-node) | Uncertain on ARM64 | PoC needed for VAD; provider integration itself is pure JS/TS |

### npm Dependency Summary

| Package | Version | Purpose | Dependencies | Bun Safe |
|---------|---------|---------|-------------|----------|
| `openai` | latest | OpenRouter LLM via baseURL override | Few, well-maintained | Yes |
| `@msgpack/msgpack` | latest | Fish Audio MessagePack serialization | Zero | Yes |
| `cockatiel` | 3.2.1 | Circuit breaker, retry, timeout | Zero | Yes |
| `yaml` | 2.8.1 | Config file parsing | Zero | Yes |

**Not using** (due to Bun issues): `@deepgram/sdk`, `fish-audio-sdk`

Total new dependencies: **4 packages**, 3 with zero transitive deps. Minimal footprint for RPi5.

### TypeScript Interface Design

Full provider contract hierarchy:

```typescript
// === Core Types ===
interface Transcript {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  confidence: number;
  words?: { word: string; start: number; end: number }[];
}

interface LLMChunk {
  text: string;
  toolCalls?: ToolCallDelta[];
  finishReason?: "stop" | "tool_calls" | "length";
}

interface ToolCallDelta {
  id: string;
  name: string;
  arguments: string; // accumulated JSON string
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// === Provider Interfaces ===
interface STTProvider {
  readonly name: string;
  connect(config: STTSessionConfig): Promise<STTSession>;
}

interface STTSession {
  send(audio: ArrayBuffer): void;
  transcripts(): AsyncGenerator<Transcript>;
  close(): Promise<void>;
  readonly state: "connecting" | "open" | "closing" | "closed";
}

interface STTSessionConfig {
  encoding: "opus" | "linear16" | "flac";
  sampleRate: number;
  channels: number;
  interimResults?: boolean;
  endpointingMs?: number;
}

interface LLMProvider {
  readonly name: string;
  stream(params: LLMRequest): AsyncGenerator<LLMChunk>;
  // Non-streaming for classifier (lower latency for short responses)
  complete(params: LLMRequest): Promise<LLMResponse>;
}

interface LLMRequest {
  model: string;
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  maxTokens?: number;
}

interface LLMResponse {
  text: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  usage: { promptTokens: number; completionTokens: number };
}

interface TTSProvider {
  readonly name: string;
  connect(config: TTSSessionConfig): Promise<TTSSession>;
}

interface TTSSession {
  // Takes async stream of text, yields audio chunks
  synthesize(sentences: AsyncGenerator<string>): AsyncGenerator<ArrayBuffer>;
  close(): Promise<void>;
  readonly state: "connecting" | "open" | "closing" | "closed";
}

interface TTSSessionConfig {
  voiceId: string;
  format: "opus" | "pcm" | "mp3";
  sampleRate: number;
  latencyMode?: "normal" | "balanced" | "low";
}

// === Provider Registry ===
interface ProviderRegistry {
  getSTT(): STTProvider;        // Returns highest-priority healthy provider
  getLLM(): LLMProvider;
  getTTS(): TTSProvider;
  health(): ProviderHealth[];   // Circuit breaker states
}
```

### Streaming Overlap Architecture

The critical latency optimization — TTS starts on the first complete sentence while LLM continues generating:

```
Time →
LLM:  [chunk1][chunk2][chunk3="Hello."][chunk4][chunk5][chunk6="How are"][chunk7=" you?"]
                       ↓ sentence detected                              ↓ sentence detected
Split:                 "Hello."                                         "How are you?"
                       ↓                                                ↓
TTS:                   [synth "Hello."][audio chunks...]                [synth "How are you?"]
                                       ↓                                               ↓
Client:                                [play audio]                                    [play audio]
```

Without overlap: user waits for full LLM response + full TTS synthesis (e.g., 2s + 1s = 3s).
With overlap: user hears first sentence after ~500ms LLM + ~200ms TTS = ~700ms perceived latency.

This is a **50-70% reduction** in perceived latency. The AsyncGenerator pattern makes this composition natural — `sentenceSplit()` yields as soon as a sentence boundary is detected, and the TTS session immediately begins synthesis.

### Barge-in (Cancel Propagation)

When user interrupts mid-response, cancel must propagate through the entire pipeline:

```typescript
class PipelineSession {
  private abortController = new AbortController();
  
  bargeIn() {
    this.abortController.abort(); // Signals all generators to stop
    // Each generator checks signal or catches AbortError
  }
}

// In each generator:
async function* streamLLM(request: LLMRequest, signal: AbortSignal): AsyncGenerator<LLMChunk> {
  const response = await fetch(url, { signal, /* ... */ });
  for await (const chunk of response.body) {
    if (signal.aborted) return;
    yield parseSSEChunk(chunk);
  }
}
```

AbortController/AbortSignal threads through all async generators. On barge-in:
1. Abort signal fires
2. LLM fetch aborts (HTTP stream closed)
3. TTS WebSocket gets close/flush
4. Audio relay to client stops
5. New STT session picks up user's interruption

## Recommendation

**Approach A: AsyncGenerator with Raw Connections** is the clear winner.

| Criterion | A: AsyncGenerator | B: Web Streams | C: EventEmitter |
|-----------|-------------------|----------------|-----------------|
| Composability | Natural `for await` chains | `.pipeThrough()` chains | Manual plumbing |
| Backpressure | Pull-based (inherent) | Queue strategy (configurable) | None |
| Typing | Strong generic types | Verbose controller API | Weak event typing |
| Cancel propagation | `AbortSignal` + `return()` | `.cancel()` chain | Manual cleanup |
| Implementation complexity | Low | Medium-High | Low but fragile |
| Streaming overlap | Natural via yield | Possible but verbose | Possible but messy |
| Bun compatibility | Full support | Full support | Full support |

**Concrete stack**:
- STT: Raw WebSocket to Deepgram (avoid SDK)
- LLM: `openai` SDK with OpenRouter baseURL override
- TTS: Raw WebSocket + `@msgpack/msgpack` to Fish Audio (avoid SDK)
- Resilience: `cockatiel` for circuit breaker/retry/timeout
- Config: `yaml` for YAML parsing with env var resolution
- Pattern: AsyncGenerator interfaces for all streaming, AbortSignal for cancellation

**Total new npm deps**: 4 packages (openai, @msgpack/msgpack, cockatiel, yaml), minimal transitive dependency footprint.

## Open Questions (Pre-PoC — mostly resolved)
- ~~Bun WebSocket binary frame fragmentation~~ — **RESOLVED**: PoC validated 1B–64KB frames, all correct
- ~~Fish Audio MessagePack~~ — **RESOLVED**: PoC validated encode/decode over Bun WebSocket, 0.76μs/encode, 0.60μs/decode
- OpenAI SDK Bun compatibility: likely fine (primarily HTTP/fetch), but confirm streaming iteration works
- Cockatiel circuit breaker state persistence: on gateway restart, do breakers reset? (Acceptable for home use — restart is rare)
- ~~`Bun.serve()` WebSocket vs outgoing `new WebSocket()`~~ — **RESOLVED**: PoC ran both simultaneously (Deepgram binary + Fish Audio MessagePack), no issues

---

## Decomposition

### PoC Validated (provider-integration-bun-ws — 60/60 pass)
- MessagePack encode/decode: 0.76μs/0.60μs per op
- Binary frame integrity: 1B–64KB all correct over Bun WebSocket
- Fish Audio client protocol: StartEvent → TextEvent → FlushEvent → StopEvent, audio chunks received
- Sentence splitter: abbreviations, decimals, ellipsis, newlines, streaming accumulation all correct
- Streaming overlap: first audio at 12ms/62ms total (80% earlier), 5-sentence pipeline 40ms/376ms (89% earlier)
- Barge-in: cancel after 3 chunks, only 3/5 sentences sent
- Concurrent 10-session MessagePack: 170K ops/sec
- Deepgram binary + Fish Audio MessagePack coexistence on same Bun process

### Sub-Area 1: Testing Strategy

#### Mock Contracts
Each provider interface (`STTProvider`, `LLMProvider`, `TTSProvider`) needs a mock implementation for gateway-level testing without hitting real APIs.

**STT Mock:**
- `MockSTTSession` implements `STTSession` — accepts audio via `send()`, yields pre-configured `Transcript` objects from `transcripts()` AsyncGenerator
- Configurable: latency per transcript, partial vs final sequence, `speechFinal` triggers, error injection (timeout, disconnect)
- Used by: classifier tests (need STT output), pipeline integration tests, barge-in tests

**LLM Mock:**
- `MockLLMProvider` implements `LLMProvider` — `stream()` yields pre-configured `LLMChunk` sequence, `complete()` returns pre-configured `LLMResponse`
- Configurable: per-chunk delay (simulate SSE), tool call sequences, finish reasons, error injection (rate limit, timeout)
- Critical for: ReAct loop tests (multi-turn tool calls), streaming overlap tests, context budget tests

**TTS Mock:**
- `MockTTSSession` implements `TTSSession` — `synthesize()` yields pre-configured `ArrayBuffer` chunks per input sentence
- Configurable: chunks per sentence, chunk size, synthesis delay, error injection (disconnect mid-stream)
- Used by: streaming overlap tests, barge-in cancel propagation tests

**Mock location:** `src/providers/__mocks__/` — co-located with provider implementations, importable from tests.

#### Circuit Breaker Tests
Using `cockatiel` library. Tests must cover:

1. **Happy path**: Provider responds normally → breaker stays closed → requests pass through
2. **Failure threshold**: 5 consecutive STT failures → breaker opens → requests fail-fast with `BreakerOpenError`
3. **Half-open probe**: After 30s cooldown, one request is allowed through → success closes breaker, failure re-opens
4. **Failover trigger**: STT breaker opens → `ProviderRegistry.getSTT()` returns next provider (Whisper local fallback)
5. **TTS degradation**: Fish Audio breaker opens → gateway returns text-only responses (no audio)
6. **LLM retry**: OpenRouter failure → exponential backoff retry (max 3 attempts, 1s/2s/4s) before failing
7. **Independent breakers**: STT breaker open does NOT affect LLM or TTS breakers
8. **Reset on restart**: Breaker state is in-memory only — gateway restart clears all breakers (acceptable for home use)

**Test approach:** Unit tests with mock providers + injected `cockatiel` policies. Use `jest.useFakeTimers()` (or Bun equivalent) for half-open cooldown tests.

#### Barge-in Regression Tests
Barge-in is the highest-risk async flow. Regression suite must cover:

1. **Clean cancel**: User interrupts during LLM streaming → LLM fetch aborted, TTS WebSocket flushed, no audio after cancel
2. **Cancel during TTS**: LLM complete but TTS still synthesizing → TTS stops, no more audio chunks emitted
3. **Cancel during STT**: User sends barge-in while previous STT is still processing → previous session torn down, new session starts
4. **Rapid barge-in**: Two barge-ins within 100ms → no resource leaks, no zombie generators
5. **Cancel with pending tool calls**: ReAct loop mid-execution → tool call cancelled, partial results discarded
6. **AbortSignal propagation**: Signal reaches all generators within one event loop tick (verified via mock latency measurement)
7. **Resource cleanup**: After barge-in, WebSocket connections are properly closed (not leaked), verified via connection count assertion

**Test approach:** Integration tests with mock providers. Pipeline assembled as in production, AbortController triggered at different stages.

### Sub-Area 2: Sentence Splitter Spec

The PoC sentence splitter works but needs a formal specification for edge cases that will appear in production LLM output.

#### Current Implementation (validated in PoC)
- Period + space + uppercase → split
- `?` and `!` (including chains `!!`, `?!`) → split immediately
- Newline → split
- Abbreviations (Dr., e.g., approx., etc.) → no split
- Decimal numbers (3.14) → no split
- Ellipsis (...) → no split
- Trailing period without follower → hold in buffer (wait for more text)

#### Additional Edge Cases to Specify
1. **Quoted speech**: `She said "Hello." Then left.` — period inside quotes should not split mid-quote
2. **URLs**: `Visit https://example.com. Then click login.` — periods in URLs must not split
3. **Parentheticals**: `The result (see Fig. 1) was good.` — period after closing paren is a sentence end
4. **Numbered lists**: `1. First item\n2. Second item` — numbered list items are sentence boundaries (via newline)
5. **Code blocks**: LLM may output code with periods — if inside backticks, don't split
6. **Very long sentences**: If a sentence exceeds 500 characters without a boundary, force-yield at the last clause boundary (comma + space) to prevent TTS latency spikes. This is a TTS quality tradeoff — long sentences sound worse than split ones.
7. **Empty/whitespace-only**: Yield nothing, don't send empty strings to TTS

#### Spec Decision: Flush Timeout
If no sentence boundary is detected within 2 seconds of accumulated text, force-flush the buffer as a sentence. This prevents the case where a slow LLM generates a long sentence and the user hears nothing for seconds. The 2-second timeout is a UX choice — better to hear a partial sentence than wait in silence.

#### Implementation Notes
- The splitter is ~130 lines in the PoC — keep it simple, don't over-engineer
- URL detection: simple regex `/https?:\/\/\S+/` to skip periods within URLs
- Quote detection: track open/close quotes, suppress splitting inside quotes
- These additions are ~50 more lines, not a major complexity increase

### Sub-Area 3: Per-Session Memory Budget for 10 Concurrent Sessions

The gateway supports up to 10 concurrent sessions (5 family + 5 guests). Each session holds state in memory. Need to budget for RPi5's 8GB RAM constraint.

#### Per-Session Memory Components

| Component | Estimated Size | Notes |
|-----------|---------------|-------|
| WebSocket connection (client) | ~64 KB | Bun WebSocket buffers, send/receive queues |
| WebSocket connection (Deepgram STT) | ~64 KB | Outgoing WS to cloud STT |
| WebSocket connection (Fish Audio TTS) | ~64 KB | Outgoing WS to cloud TTS |
| Conversation history | ~200 KB max | Context window budget: ~80% of model context, stored as Message[] array. Oldest messages evicted. Typical session: 20-50 messages = 50-100 KB |
| User memory (loaded from file) | ~5 KB | `memory/<user>.md` loaded at session start, ~600 tokens ≈ 2.4 KB text |
| Persona (shared, read-only) | ~3 KB (shared) | `persona.md` loaded once, referenced by all sessions |
| STT transcript buffer | ~10 KB | Accumulates partial/final transcripts for current utterance |
| LLM streaming buffer | ~50 KB | SSE chunk accumulation, tool call JSON assembly |
| TTS sentence buffer | ~5 KB | Sentence splitter accumulation buffer |
| Audio ring buffer (pre-trigger) | 0 KB | Ring buffer is CLIENT-SIDE only. Gateway receives pre-trigger as one binary frame |
| AbortController + signal refs | ~1 KB | Per-pipeline cancellation |
| Session metadata | ~2 KB | User ID, role, session ID, timestamps, auth token claims |
| Skill execution context | ~20 KB | Only during active skill execution: scoped tool set, ReAct loop state, intermediate results |
| Circuit breaker state | ~1 KB (shared) | Per-provider, not per-session |

#### Per-Session Total: ~484 KB typical, ~600 KB peak

#### 10-Session Aggregate

| Metric | Value |
|--------|-------|
| 10 sessions typical | ~4.8 MB |
| 10 sessions peak | ~6.0 MB |
| Shared state (persona, config, circuit breakers) | ~500 KB |
| Bun runtime overhead | ~50-80 MB |
| Total gateway memory (10 sessions) | ~60-90 MB |

**Verdict: 8GB RPi5 has massive headroom.** Even at peak, the gateway uses <2% of available RAM. The remaining 7.9 GB is available for:
- Local Whisper.cpp STT fallback (~1-2 GB when active)
- OS and system services (~500 MB)
- SSD-backed swap (500GB SSD, not typically needed)

#### Memory Management Strategy
1. **No pooling needed**: 10 sessions × 600 KB = 6 MB — trivial. Allocate per-session, GC on session end.
2. **Conversation history cap**: Hard cap at 200 KB per session. Evict oldest messages (newest-first priority, matching persona-memory context budgeting).
3. **Guest sessions**: Identical memory footprint but ephemeral — no file I/O for memory load/save.
4. **LLM streaming buffer**: Reset after each response completes. No accumulation across turns.
5. **WebSocket connections**: 3 outgoing WS per active session (STT + TTS + LLM SSE). Deepgram and Fish Audio connections can be lazy-opened (only when user is speaking / response is generating) to reduce idle overhead. LLM uses HTTP fetch, not persistent WS.
6. **Monitoring**: Log per-session memory at session start/end for operational visibility. No need for runtime profiling on RPi5 — the numbers are small enough to reason about statically.

#### Risk: Memory Leak from Unclosed Generators
AsyncGenerators that are not fully consumed or explicitly `.return()`ed can hold references indefinitely. Mitigations:
- Every barge-in path MUST call `.return()` on all active generators
- Session cleanup on disconnect MUST tear down all generators
- AbortSignal acts as a safety net — generators check `signal.aborted` and exit
- Add a session-level timeout (e.g., 30 minutes of inactivity) that forces cleanup

### Testing Strategy Summary

| Layer | What | How | Count |
|-------|------|-----|-------|
| Unit | Sentence splitter edge cases | Pure function tests, no mocks needed | ~30 cases |
| Unit | Mock provider contracts | Verify mocks match interface types | ~10 cases |
| Unit | Circuit breaker policies | Mock providers + cockatiel + fake timers | ~15 cases |
| Integration | Streaming overlap pipeline | Mock LLM → real splitter → mock TTS | ~10 cases |
| Integration | Barge-in cancel propagation | Full pipeline with mocks, AbortController trigger | ~10 cases |
| Integration | Provider failover | Mock primary (fail) + mock secondary (succeed) | ~5 cases |
| E2E (PoC-level) | Real provider round-trip | Actual Deepgram/Fish Audio/OpenRouter (manual, not CI) | ~5 cases |
| **Total** | | | **~85 cases** |

**Test runner:** `bun test` (built-in, Jest-compatible API). No additional test framework dependency.

### Open Questions (Post-Decomposition)
1. **OpenAI SDK streaming on Bun**: Not yet validated in PoC. Low risk (HTTP/fetch-based), but should be tested before production use.
2. **Cockatiel half-open timer accuracy on Bun**: Bun's timer implementation may differ from Node.js for sub-second precision. Test with real timers, not just fake timers.
3. **Fish Audio connection pooling**: Should TTS connections be kept alive between utterances (persistent) or opened per-response (transient)? Persistent saves ~100ms connection overhead but holds resources during silence. Recommendation: persistent with 30s idle timeout.
