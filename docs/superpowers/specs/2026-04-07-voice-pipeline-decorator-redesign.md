# Voice Pipeline Decorator Redesign

## Context

The current voice pipeline has three compounding issues:

1. **Audio corruption.** LLM output containing markdown (`**`, `--`, `\n\n`, `#`) passes to Fish Audio TTS verbatim, producing gibberish. No text sanitization exists anywhere in the pipeline.

2. **Per-sentence TTS connections.** Each `synthesize()` call opens a fresh WebSocket to Fish Audio (200-2000ms handshake). A typical response creates 5-10 connections. Fish Audio's streaming protocol supports multiple `text` events on one connection, but we don't use it.

3. **Sequential service init.** STT (Deepgram) and TTS (Fish Audio) connect sequentially at session start. TTS `connect()` is a no-op — actual connections are deferred to first `synthesize()` call.

Additionally, the pipeline lacks a composable processing chain. Future features (LLM tool call loops, TTS emotion formatting) require post-processing the full LLM text before TTS — currently impossible without restructuring.

## Design

### Decorator Unit Pipeline

The pipeline carries a **dual-channel chunk** through every stage — one channel for display (what the user reads in chat), one for speech (what TTS speaks aloud):

```typescript
interface PipelineChunk {
  display: string;  // for UI text rendering
  speech: string;   // for TTS audio generation
}
```

Both channels start identical (raw LLM output). Each decorator unit receives both and decides which to modify:
- **Sanitizer**: modifies `speech` (strips markdown), leaves `display` as-is
- **Future tool call unit**: modifies both — `display` → "Searching the web...", `speech` → "Let me look that up"
- **Future emotion tagger**: modifies `speech` only (adds provider emotion tags)

The standard contracts:

```typescript
type TextTransform = (input: AsyncGenerator<PipelineChunk>, signal: AbortSignal) => AsyncGenerator<PipelineChunk>;

// Terminal stage yields a unified output stream — both audio and display text
type PipelineOutput =
  | { type: "audio"; frame: AudioFrame }
  | { type: "text"; display: string };

type AudioTransform = (input: AsyncGenerator<PipelineChunk>, signal: AbortSignal) => AsyncGenerator<PipelineOutput>;
```

The terminal stage consumes `.speech` for TTS audio and emits `.display` as text events — both in the same output stream. The voice-turn orchestrator consumes this single stream and routes: `audio` → binary WS send, `text` → JSON text delta to client.

Units compose by chaining. A unit that needs full context buffers internally — the pipeline doesn't know or care.

**Current pipeline (after this redesign):**
```
LLM tokens → [to PipelineChunk] → TTS text sanitizer → TTS box → PipelineOutput stream
                                                                    ├─ { type: "audio" } → binary WS
                                                                    └─ { type: "text" }  → JSON text delta
```

**Future pipeline (plug in units):**
```
LLM tokens → [to PipelineChunk] → sanitizer → tool calls → emotion tagger → TTS box → PipelineOutput stream
```

Full rules: `.claude/rules/pipeline.md`. Examples: `agents/docs/pipeline-details.md`.

### Component 1: TTS Text Sanitizer

**File:** `gateway/src/pipeline/processors/tts-text-sanitizer.ts`

A streaming `TextTransform` — yields cleaned chunks as they arrive, no buffering. Modifies `.speech` only; passes `.display` through unchanged.

Strips (from `.speech` channel):
- Markdown emphasis: `**`, `*`, `__`, `_`, `~~`
- Headers: `#`, `##`, etc.
- Horizontal rules: `---`, `***`, `___`
- List markers: `- `, `* `, `1. ` at line starts
- Blockquotes: `> ` at line starts
- Code fences: triple backticks
- Normalizes `\r\n` and `\n` to space (preserving sentence boundaries)
- Collapses multiple spaces to one

Does NOT strip:
- Punctuation that affects speech: `.`, `!`, `?`, `,`, `;`, `:`, `'`, `"`
- Parentheses, quotes
- Numbers, currency symbols

**Cross-chunk handling:** LLM tokens are tiny (1-5 chars). Markdown like `**` could arrive as one token or be split across tokens. The sanitizer strips individual markdown characters (`*`, `_`, `~`, `#`) rather than matching paired delimiters. This works regardless of chunk boundaries — `**hello**` arriving as `**` + `hello` + `**` still yields `hello`.

Pure function internally — `sanitizeSpeech(text: string): string`. Wrapped in the `TextTransform` generator signature: receives `PipelineChunk`, applies sanitization to `.speech`, yields chunk with `.display` unchanged.

### Component 2: Persistent Fish Audio Connection

**File:** `gateway/src/providers/tts/fish-audio-provider.ts` (refactored)

Replace per-sentence connections with one connection per turn.

**TTSProvider interface evolution:**
```typescript
interface TTSProvider {
  connect(config: TTSConfig, signal: AbortSignal): Promise<void>;  // pre-warm: opens WS, sends `start`
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<TTSAudioChunk>;  // sends `text` event on existing WS
  endTurn(): Promise<void>;  // NEW: sends `stop`, waits for `finish`, closes WS
  disconnect(): Promise<void>;  // cleanup, releases resources
}
```

`connect()` changes from a no-op config stash to actually opening the Fish Audio WS and sending the `start` message. The connection is warm and ready after `connect()` resolves.

**Connection lifecycle per turn:**
1. `connect(config, signal)` — opens WS, sends `start` message. Called at session start (pre-warm) and again before each subsequent turn.
2. `synthesize(text, signal)` — sends a `text` event on the existing WS. Yields audio chunks as they arrive.
3. `endTurn()` — sends `stop` event, waits for `finish` response, closes WS. Called by the TTS terminal stage when the sentence stream is exhausted.
4. Next turn: `connect()` is called again to open a fresh WS.
5. `disconnect()` — closes WS if open, releases resources.

**Barge-in:** The turn's `AbortSignal` fires → TTS terminal stage stops consuming → flow manager calls `disconnect()` on the current connection (kills all pending audio), then `connect()` to pre-warm for the next turn.

**Audio queue refactor:** Replace the bare `pending: TTSAudioChunk[]` with a ring buffer:
- Initial capacity: 600 chunks (120s at 200ms chunk rate)
- Grows: double capacity when queue reaches 50% fill (at 300 chunks → 1200)
- Reset: shrink to initial 600 between turns
- Includes `waitForItem(signal)` for async consumption (existing pattern preserved)

### Component 3: Parallel Service Initialization

**File:** `gateway/src/pipeline/continuous-session.ts` (refactored)

Current `doConnect()` is sequential:
```typescript
await sttProvider.connect(sttConfig, signal);  // wait...
await ttsProvider.connect(ttsConfig, signal);  // then wait...
```

New:
```typescript
await Promise.all([
  sttProvider.connect(sttConfig, signal),
  ttsProvider.connect(ttsConfig, signal),  // now actually opens WS
]);
```

Since TTS `connect()` now actually opens the Fish Audio WS (pre-warm), this overlaps the TTS handshake with the STT handshake. Saves 200-2000ms on first response.

**State machine impact:** The continuous session already tracks `sttConnected` and `ttsConnected` flags. With parallel init, both become true at roughly the same time. The early audio buffer (for audio arriving before STT is ready) still works — audio is buffered until `sttConnected` is true, then flushed.

If one service fails, the other should still be cleaned up. Wrap with proper error handling:
```typescript
const results = await Promise.allSettled([sttInit, ttsInit]);
// If either rejected, clean up the successful one and throw
```

### Component 4: Persona Update

**File:** `gateway/persona.md`

Add a strict "Voice Output" section with strong language. The LLM must never produce visual formatting in voice responses. This is a defense-in-depth measure alongside the sanitizer — the sanitizer catches what slips through, but the persona should prevent most formatting at the source.

New section to add:

```markdown
## Voice Output Rules — CRITICAL
You are speaking out loud. Every response will be read aloud by a text-to-speech engine.
- NEVER use markdown formatting of any kind: no **bold**, no *italic*, no __underline__, no ~~strikethrough~~.
- NEVER use headers (#), horizontal rules (---), bullet points (- or *), or numbered lists (1.).
- NEVER use code blocks, backticks, or any visual formatting.
- NEVER use special characters for emphasis or decoration: no asterisks, no dashes as separators, no equals signs.
- Speak in natural conversational sentences, as if talking to someone in the room.
- Use pauses naturally through punctuation: commas, periods, question marks.
- If listing items, say them conversationally: "first... second... and third..." — not as a formatted list.
- If you need to emphasize something, use words: "this is really important" — not formatting.
```

### Component 5: Pipeline Composition in Voice Turn

**File:** `gateway/src/pipeline/voice-turn.ts` (refactored)

Currently `voice-turn.ts` manually wires LLM tokens through `streaming-overlap.ts` which internally manages both sentence aggregation and TTS.

After redesign, `voice-turn.ts` composes the decorator pipeline and taps both channels:

```typescript
// Convert raw LLM tokens to PipelineChunk (both channels identical initially)
function* toPipelineChunks(tokens: AsyncGenerator<string>): AsyncGenerator<PipelineChunk> { ... }

// Compose text decorators
function buildTextPipeline(llmTokens: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<PipelineChunk> {
  const chunks = toPipelineChunks(llmTokens);
  return sanitizeForTts(chunks, signal);
  // Future: return emotionTagger(sanitizeForTts(chunks, signal), signal);
}

// Terminal stage yields unified PipelineOutput — orchestrator just routes
const pipeline = buildTextPipeline(llmTokens, signal);
for await (const event of ttsStage(pipeline, signal)) {
  if (event.type === "text") sendTextDelta(event.display);
  if (event.type === "audio") sendBinaryFrame(event.frame);
}
```

The `streaming-overlap.ts` simplifies into the TTS terminal stage — it receives `AsyncGenerator<PipelineChunk>` and yields `AsyncGenerator<PipelineOutput>`. For each incoming chunk it yields `{ type: "text", display }` immediately, and feeds `.speech` to the sentence aggregator. As sentences complete and TTS produces audio, it yields `{ type: "audio", frame }`. The existing parallel pattern persists: a consumer task reads chunks from the input stream, emits display text events, and feeds `.speech` to the sentence aggregator via `addToken()`, while the main generator iterates `aggregator.sentences()` and sends each sentence to TTS. The difference is the consumer's source changes from direct LLM tokens to the upstream `PipelineChunk` stream (already sanitized).

## Files Changed

### Gateway

| File | Action | Description |
|------|--------|-------------|
| `gateway/src/pipeline/processors/tts-text-sanitizer.ts` | NEW | Streaming text sanitizer (`.speech` only) |
| `gateway/src/pipeline/processors/tts-text-sanitizer.test.ts` | NEW | Sanitizer tests |
| `gateway/src/pipeline/processors/pipeline-types.ts` | NEW | `PipelineChunk`, `PipelineOutput`, `TextTransform`, `AudioTransform` types |
| `gateway/src/providers/tts/fish-audio-provider.ts` | REFACTOR | Persistent per-turn connection |
| `gateway/src/providers/tts/fish-audio-provider.test.ts` | REFACTOR | Updated provider tests |
| `gateway/src/providers/tts/audio-chunk-queue.ts` | NEW | Ring buffer queue |
| `gateway/src/providers/tts/audio-chunk-queue.test.ts` | NEW | Queue tests |
| `gateway/src/pipeline/processors/streaming-overlap.ts` | REFACTOR | TTS terminal stage: `PipelineChunk` in → `PipelineOutput` out |
| `gateway/src/pipeline/processors/streaming-overlap.test.ts` | REFACTOR | Updated tests |
| `gateway/src/pipeline/voice-turn.ts` | REFACTOR | Compose decorator pipeline, route `PipelineOutput` to WS |
| `gateway/src/pipeline/voice-turn.test.ts` | REFACTOR | Updated tests |
| `gateway/src/pipeline/continuous-session.ts` | REFACTOR | Parallel service init |
| `gateway/src/pipeline/continuous-session.test.ts` | REFACTOR | Updated tests |
| `gateway/src/server/continuous-voice-handler.ts` | REFACTOR | Consume `PipelineOutput` stream (text + audio routing) |
| `gateway/src/server/continuous-voice-handler.test.ts` | REFACTOR | Updated tests |
| `gateway/persona.md` | MODIFY | Add voice output rules |

### Shared / SDK

| File | Action | Description |
|------|--------|-------------|
| `shared/protocol/src/messages.ts` | AUDIT | Verify message schemas still match new gateway output |
| `shared/web-sdk/src/voice-client.ts` | AUDIT | Verify binary/JSON routing handles any new or changed message types |
| `shared/web-sdk/src/voice-state-machine.ts` | AUDIT | Verify states and transitions still match gateway event sequence |
| `shared/web-sdk/src/voice-client.test.ts` | UPDATE | Add tests for any changed message handling |

### Web Client

| File | Action | Description |
|------|--------|-------------|
| `web/src/hooks/use-voice.ts` (or equivalent) | UPDATE | Update to consume new SDK API if interface changed |
| `web/src/components/` | UPDATE | Update UI components to handle any new states or events from SDK |
| `web/src/adapters/web-audio-playback.ts` | AUDIT | Verify playback adapter still compatible with new audio frame delivery |

### Rules & Docs

| File | Action | Description |
|------|--------|-------------|
| `.claude/rules/pipeline.md` | DONE | Pipeline decorator rules |
| `agents/docs/pipeline-details.md` | DONE | Rule examples and explanations |

The SDK and web client changes depend on whether the gateway's new pipeline changes the WebSocket protocol (message types, event sequence, state transitions). The implementation plan must audit these during the gateway refactor and update the client side to comply. If the message contract is unchanged (same JSON types, same binary format), client changes are minimal. If new message types or changed event ordering result from the pipeline redesign, the SDK and web client must be updated to match.

## Testing Strategy

- **TTS text sanitizer:** Unit tests with markdown-heavy inputs, edge cases (nested formatting, partial markdown at chunk boundaries), and verification that speech punctuation is preserved.
- **Audio chunk queue:** Unit tests for capacity, growth at 50%, reset, ring buffer wraparound, concurrent enqueue/dequeue.
- **Fish Audio provider:** Integration tests with mock WS verifying: single connection per turn, multiple text events, stop/finish lifecycle, barge-in reset, abort cleanup.
- **Parallel init:** Test that both services init concurrently, test failure of one while other succeeds, test cleanup on partial failure.
- **Pipeline composition:** End-to-end test: LLM tokens with markdown → sanitized text → mock TTS → clean audio frames. Verify no markdown reaches TTS.
- **Persona:** Manual verification — send markdown-inducing prompts, confirm LLM avoids formatting.
- **SDK/client compliance:** After gateway changes, run full web-sdk test suite. If message types or event ordering changed, update SDK message handling and voice state machine transitions accordingly. Web client must render any new states correctly.

## Not In Scope

- LLM tool call loop (future feature — plugs in as a decorator unit)
- TTS emotion formatter (future feature — plugs in as a buffering decorator unit)
- Connection pooling across sessions (single-user Pi deployment, not needed)
- Alternative TTS provider fallback (Cartesia, ElevenLabs — future)
