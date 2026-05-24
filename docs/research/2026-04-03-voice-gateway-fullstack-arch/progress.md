# Architecture Expansion Progress

## Scoreboard
| Decision Area | Status | Feas | Maint | Risk | Effort | Align | Total | Δ | Streak | Approaches |
|---------------|--------|------|-------|------|--------|-------|-------|---|--------|------------|
| gateway-core | ACTIVE | 8 | 6 | 6 | 9 | 9 | 38 | 38 | 0 | 3 |
| stt-strategy | ACTIVE | 5 | 5 | 7 | 6 | 8 | 31 | 31 | 0 | 3 |
| classifier-tool-routing | ACTIVE | 5 | 6 | 6 | 6 | 8 | 31 | 31 | 0 | 3 |
| skill-system | ACTIVE | 5 | 6 | 7 | 8 | 9 | 35 | 35 | 0 | 3 |
| persona-memory | ACTIVE | 7 | 6 | 7 | 8 | 9 | 37 | 37 | 0 | 3 |
| security-guest-mode | ACTIVE | 5 | 6 | 7 | 6 | 9 | 33 | 33 | 0 | 3 |
| wake-word-audio-buffering | ACTIVE | 6 | 5 | 7 | 7 | 9 | 34 | 34 | 0 | 3 |
| android-client | ACTIVE | 5 | 5 | 6 | 7 | 8 | 31 | 31 | 0 | 3 |
| ios-client | ACTIVE | 6 | 5 | 7 | 7 | 8 | 33 | 33 | 0 | 3 |
| client-gateway-protocol | ACTIVE | 6 | 6 | 7 | 8 | 9 | 36 | 36 | 0 | 3 |
| provider-integration-ts | ACTIVE | 5 | 5 | 6 | 8 | 9 | 33 | 33 | 0 | 3 |
| web-client | ACTIVE | 5 | 6 | 7 | 7 | 9 | 34 | 34 | 0 | 3 |

## Task Queue

> For every `Score` task: you MUST read `expansion-loop.md` and `scoring-rubric.md` before starting. Do not score from memory or assumption.

- [x] Decompose: read seed architecture, create exploration files in explorations/
- [x] Survey: all decision areas (skim landscape, log in sources.md)
- [x] Explore: gateway-core
- [x] Explore: stt-strategy
- [x] Explore: classifier-tool-routing
- [x] Explore: skill-system
- [x] Explore: persona-memory
- [x] Explore: security-guest-mode
- [x] Explore: wake-word-audio-buffering
- [x] Explore: android-client
- [x] Explore: ios-client
- [x] Explore: client-gateway-protocol
- [x] Explore: provider-integration-ts
- [x] Explore: web-client
- [x] Synthesize: update architecture.md
- [x] Score: gateway-core → 38/50 (F:8 M:6 R:6 E:9 A:9) Δ38 streak=0
- [x] Score: stt-strategy → 31/50 (F:5 M:5 R:7 E:6 A:8) Δ31 streak=0
- [x] Score: classifier-tool-routing → 31/50 (F:5 M:6 R:6 E:6 A:8) Δ31 streak=0
- [x] Score: skill-system → 35/50 (F:5 M:6 R:7 E:8 A:9) Δ35 streak=0
- [x] Score: persona-memory → 37/50 (F:7 M:6 R:7 E:8 A:9) Δ37 streak=0
- [x] Score: security-guest-mode → 33/50 (F:5 M:6 R:7 E:6 A:9) Δ33 streak=0
- [x] Score: wake-word-audio-buffering → 34/50 (F:6 M:5 R:7 E:7 A:9) Δ34 streak=0
- [x] Score: android-client → 31/50 (F:5 M:5 R:6 E:7 A:8) Δ31 streak=0
- [x] Score: ios-client → 33/50 (F:6 M:5 R:7 E:7 A:8) Δ33 streak=0
- [x] Score: client-gateway-protocol → 36/50 (F:6 M:6 R:7 E:8 A:9) Δ36 streak=0
- [x] Score: provider-integration-ts → 33/50 (F:5 M:5 R:6 E:8 A:9) Δ33 streak=0
- [x] Score: web-client → 34/50 (F:5 M:6 R:7 E:7 A:9) Δ34 streak=0
- [x] PoC: stt-deepgram-raw-ws — validate Bun binary WebSocket to Deepgram + double-endpointing
- [x] Decompose: stt-strategy — break into endpointing, provider integration, offline fallback; define test strategy
- [x] PoC: classifier-regex-validation — 78/78 pass, 0% FP rate, weather regex fixed, 0.37μs/call latency
- [x] PoC: skill-system-scoped-react — 27/27 pass, sandbox blocks all undeclared tools, 0.088ms/parse, 0.004ms/ReAct-loop, cycle detection 0.006ms/50-skills
- [x] PoC: security-paseto-bun — 14/14 pass both runtimes. Bun: encrypt=0.067ms decrypt=0.030ms roundtrip=0.042ms. Node: encrypt=0.072ms decrypt=0.035ms roundtrip=0.065ms. Injection guard: 95.7% detection (22/23), 0% FP (0/24), 1.65μs/call. paseto-ts v2.0.5 works on Bun+Node via Web Crypto API. addExp short-duration parsing broken (defaults 1h), use explicit ISO exp claims instead. Token size 399 chars. Key gen 0.005ms.
- [x] Decompose: wake-word-audio-buffering — shared wire protocol contract (pcm_s16le, 64KB ring buffer, pre-trigger transmission sequence), testing strategy (ring buffer unit tests, pipeline integration tests, e2e protocol tests per platform), thread-safety model (Android: dedicated thread + Channel, iOS: real-time thread + Actor/AsyncStream, Web: AudioWorklet + MessagePort), Porcupine/Opus frame mismatch resolved (independent consumers)
- [x] PoC: android-client-audio-pipeline — 115/115 pass. RingBuffer: wrap-around correct, drain oldest-first, 64KB capacity, 0.098μs/write, 8.9μs/fill+drain. FrameAccumulator: variable chunks→exact 512-sample frames, ByteArray race condition FIXED (copy-on-emit). Pipeline: detection→drain→stream→silence lifecycle, 500ms debounce, pre-trigger capped at 2000ms/64KB. Wire protocol: session.start+binary+audio.end sequence correct. Full pipeline 64,178x real-time.
- [x] Decompose: android-client — 5 sub-areas: audio pipeline (VALIDATED via PoC 115/115), service lifecycle/binding (foreground service + bound service + Hilt DI), auth token storage (EncryptedSharedPreferences + Keystore-backed AES-256), test strategy (unit/integration/UI/e2e matrix), Opus/Porcupine frame mismatch (RESOLVED — independent accumulators). Package structure defined.
- [x] Decompose: ios-client — 6 sub-areas: audio pipeline (AVAudioEngine + FrameAccumulator + pipeline state machine), TPCircularBuffer SPM integration (local package with Swift wrapper), auth token Keychain storage (actor-based, kSecAttrAccessibleAfterFirstUnlock), AsyncStream backpressure (.bufferingNewest(64), drop-oldest policy), test strategy (mock AVAudioEngine via protocol extraction, mock Porcupine via WakeWordDetector protocol, XCTest unit/integration/UI matrix), Opus/Porcupine frame mismatch (RESOLVED — independent accumulators). Package structure defined.
- [x] PoC: provider-integration-bun-ws — 60/60 pass. MessagePack encode 0.76μs/decode 0.60μs. Binary frame integrity 1B–64KB all correct. Fish Audio client: auth+StartEvent+TextEvent+FlushEvent+StopEvent protocol validated, audio chunks received correctly. Sentence splitter: abbreviations (Dr./e.g./approx.), decimals (3.14), ellipsis, newlines, streaming accumulation all correct. Streaming overlap: first audio at 12ms/62ms total (80% earlier), 5-sentence pipeline first audio at 40ms/376ms (89% earlier). Barge-in: cancel after 3 chunks, only 3/5 sentences sent. Concurrent 10-session MessagePack: 170K ops/sec. Deepgram binary + Fish Audio MessagePack coexistence validated on same Bun process.
- [x] Decompose: provider-integration-ts — 3 sub-areas: testing strategy (mock contracts for STT/LLM/TTS, circuit breaker tests with cockatiel+fake timers, barge-in regression suite 7 scenarios), sentence splitter spec (6 new edge cases: quoted speech, URLs, parentheticals, lists, code blocks, long sentences; 2s flush timeout), per-session memory budget (484KB typical / 600KB peak per session, 10 sessions = ~60-90MB total including Bun runtime, RPi5 8GB has massive headroom). ~85 test cases planned. Generator leak mitigation via mandatory .return() + AbortSignal + session timeout.
- [x] PoC: web-client-ptt-audio — 71/71 pass. Ring buffer: wrap-around, overflow drop-oldest, underrun tracking, barge-in instant clear all correct. WebM parser: custom zero-dep EBML parser extracts DocType=webm, CodecID=A_OPUS, TrackType=2(audio), SimpleBlocks from container; chunked streaming parse produces identical results to full parse; Chrome-header byte sequence parsed correctly; resilient to garbage input. WebSocket echo: binary round-trip byte-for-byte correct, 1B–64KB frame sizes all pass, mixed binary+text interleaving works, 50-frame burst delivery correct. COOP/COEP: Cross-Origin-Opener-Policy=same-origin + Cross-Origin-Embedder-Policy=require-corp confirmed on all endpoints (HTML, worklet JS, health, test) — required for SharedArrayBuffer/AudioWorklet. PTT lifecycle: session.ready→audio.start→WebM header+chunks→audio.end→metrics, server-side WebM parse extracts codec+track+blocks correctly. Rapid 3x PTT toggle: no frame loss. Latency: min=0.07ms avg=0.14ms max=0.48ms echo round-trip. Concurrent: 10 sessions × 20 frames = 200/200 delivered, cleanup verified. AudioWorklet ring buffer processor: 96KB buffer (2s@48kHz), drop-oldest overflow, partial-read underrun detection, barge-in clear <1 process() cycle.
- [x] Synthesize: update architecture.md
