# STT Strategy — Local vs Cloud vs Hybrid

## Decision Area
Speech-to-text approach balancing accuracy, latency, cost, and offline capability on RPi5.

## Key Questions
- Deepgram Nova-3 streaming: WebSocket API, partial transcripts, endpointing?
- Whisper.cpp on RPi5: realistic latency for streaming? Memory/CPU impact?
- Hybrid approach: local VAD + cloud STT? Local interim + cloud final?
- VAD strategy: who does endpointing — client, gateway, or STT service?
- Cost at family scale (~$6/mo cloud estimate)?
- How does local STT change the "lightweight passthrough" gateway design?

## Approaches

### Approach A: Cloud-Only (Deepgram Nova-3)

**Description:** All STT is handled by Deepgram's cloud service via WebSocket streaming. The gateway relays audio from clients to Deepgram and receives transcripts back. No local STT processing.

**Architecture:**
```
Client → [audio frames] → Gateway → [relay] → Deepgram WS
                                                    ↓
Gateway ← [Results: interim/final, SpeechStarted, UtteranceEnd]
```

**Deepgram WebSocket API:**
- URL: `wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&...`
- Auth: `Authorization: Token <key>` header on upgrade
- Binary frames: send audio chunks (100-200ms recommended)
- Text frames: receive JSON events (`Results`, `SpeechStarted`, `UtteranceEnd`)
- Control: `{ type: "KeepAlive" }` every 8-10s during silence; `{ type: "CloseStream" }` for graceful close
- Codec support: linear16, opus, ogg-opus, mulaw, flac

**Endpointing — three independent mechanisms:**

| Mechanism | What it does | When to use |
|-----------|-------------|-------------|
| `is_final: true` | Model commits to a transcript segment | Accumulate these for the full utterance |
| `speech_final: true` | VAD detects silence ≥ `endpointing` ms | Primary trigger to flush buffer to LLM |
| `UtteranceEnd` | Word-gap ≥ `utterance_end_ms` (min 1000ms) | Fallback for noisy environments where VAD stalls |

Recommended config for voice agent: `interim_results=true&endpointing=300&vad_events=true&utterance_end_ms=1000`

**Correct buffer pattern:** Accumulate all `is_final: true` transcripts. When `speech_final: true` OR `UtteranceEnd` arrives (first-wins), flush accumulated text to the intelligence pipeline.

**Latency:**
- First partial transcript: ~150-300ms after audio receipt
- `is_final: true` segment: ~300-500ms
- End-to-end (speech end → LLM call start): ~600-1000ms with `endpointing=300`
- `UtteranceEnd` path: ~1300-1700ms (1000ms gap threshold)

**Cost at family scale:**

| Scenario | Daily audio | Monthly | Cost (PAYG $0.0077/min) |
|----------|-------------|---------|-------------------------|
| Light (30 min/day) | 30 min | ~900 min | **$6.93** |
| Moderate (45 min/day) | 45 min | ~1,350 min | **$10.40** |
| Heavy (60 min/day) | 60 min | ~1,800 min | **$13.86** |

- **$200 free credit on signup** → 14-19 months free at family usage levels
- Per-second billing (no rounding up)
- **Idle WebSocket: $0** — keepalive messages free, only billed on audio transmitted
- Diarization adds $0.002/min; multilingual (`language=multi`) is $0.0092/min (+19%)

**TypeScript SDK (`@deepgram/sdk` v5):**
```typescript
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
const client = createClient(DEEPGRAM_API_KEY);
const conn = client.listen.v1.connect({
  model: "nova-3", language: "en-US",
  interim_results: true, endpointing: 300,
  vad_events: true, utterance_end_ms: 1000,
  smart_format: true, punctuate: true,
  encoding: "linear16", sample_rate: 16000,
});
conn.on(LiveTranscriptionEvents.Transcript, (data) => { ... });
conn.on(LiveTranscriptionEvents.SpeechStarted, (data) => { /* barge-in */ });
conn.on(LiveTranscriptionEvents.UtteranceEnd, (data) => { /* fallback trigger */ });
```

**⚠️ CRITICAL: Bun WebSocket incompatibility.** The `@deepgram/sdk` has a confirmed, unresolved issue with Bun — binary frames sent via Bun's WebSocket arrive at Deepgram with 0 seconds duration. The SDK internally uses `ws` npm package which behaves differently under Bun's JavaScriptCore.

**Workarounds:**
1. **Raw WebSocket implementation** — Use `new WebSocket(url)` with Bun's native WS to connect directly to `wss://api.deepgram.com/v1/listen?...`. Auth via query param `token=<key>` instead of header. The protocol is simple enough to implement (~100 lines).
2. **Node.js subprocess** for STT I/O — isolate the Deepgram connection in a Node worker
3. **Use the SDK under Node.js** if gateway runtime changes

**Recommended: Option 1 (raw WebSocket).** The Deepgram streaming protocol is well-documented and the SDK is a thin wrapper. A direct implementation avoids the SDK dependency entirely and works natively with Bun.

**Family-relevant features:**
- Smart formatting (phone, currency, email — free)
- Keyterm prompting (family names, device names — $0.0013/min, up to 100 terms)
- Multilingual code-switching (`language=multi`) — handles bilingual families natively
- Diarization (speaker labels per word — $0.002/min) — useful but not identity-linked

**Pros:**
- Best-in-class accuracy: 5.26% WER (batch), 6.84% (streaming) on English
- True streaming with sub-500ms partials — best conversational feel
- Zero CPU load on RPi5 — preserves "lightweight passthrough" design
- Built-in VAD with SpeechStarted + speech_final — no separate VAD component needed
- Idle connections are free — persistent WS architecture has no cost penalty
- $200 free credit covers 14-19 months of family usage
- Handles concurrent users trivially (cloud scales independently)
- Rich endpointing with dual speech_final + UtteranceEnd for noisy environments

**Cons:**
- **Requires internet** — total STT failure during outage
- SDK incompatible with Bun (workaround: raw WebSocket implementation)
- `speech_final` unreliable in noisy environments (kids, TV, pets) — need UtteranceEnd fallback
- Monthly cost of $7-14 ongoing (after free credit exhausts)
- Privacy: audio leaves the home network
- Vendor lock-in (protocol is simple enough to swap providers, but endpointing logic differs)

**Risk factors:**
- Internet outage = no STT = assistant is dead
- Deepgram pricing changes or service discontinuation
- Audio privacy concerns for some family members

---

### Approach B: Local-Only (Whisper.cpp on RPi5)

**Description:** Run whisper.cpp as a local server process on the RPi5. Gateway buffers audio per utterance, POSTs to the local whisper-server HTTP API, receives batch transcription.

**Architecture:**
```
Client → [audio frames] → Gateway → [buffer until VAD endpoint]
                                          ↓
                              POST /inference (WAV)
                                          ↓
                              whisper-server (localhost:8080)
                                          ↓
                              { "text": "transcript" }
```

**RPi5 Performance (CPU-only, ARM64 Cortex-A76 quad-core):**

| Model | Disk | Runtime RAM | Time/10s audio | RTF | Verdict |
|-------|------|-------------|----------------|-----|---------|
| tiny.en | 75 MB | ~273 MB (F16) / ~120 MB (Q5_0) | ~5-6s | ~0.5-0.6x | Marginally real-time |
| base.en | 142 MB | ~388 MB (F16) / ~150 MB (Q5_0) | ~8-10s | ~0.8-1.0x | Borderline |
| small.en | 466 MB | ~852 MB (F16) / ~380 MB (Q5_0) | >30s | ~3x+ | Not viable |
| medium/large | 1.5-2.9 GB | 2-4 GB | System freeze | — | Ruled out |

With whisper.cpp GGML optimizations + ARM NEON + `-ac 512` flag: **base.en-q5_0 achieves ~0.2-0.35 RTF** (5s utterance in ~1-1.8s). This is the sweet spot for RPi5.

**Recommended local config:** `base.en-q5_0` with `-t 4 -ac 512` → ~150MB RAM, ~1.5-2.5s per utterance.

**whisper-server HTTP API (OpenAI-compatible):**
```
POST /inference
Content-Type: multipart/form-data
Fields: file (WAV), language, response_format, temperature, vad
Response: { "text": "...", "segments": [...] }
```

**Streaming reality:** whisper.cpp's `stream` example is **not true streaming** — it's chunked batch processing with a sliding window. The model needs a complete audio segment before producing output. "Streaming" is a latency-reduction trick via overlapping windows, not architectural streaming like Deepgram.

**VAD in whisper.cpp:**
- Built-in energy-based VAD (simple amplitude threshold — basic)
- Silero-VAD-v5 GGML model support via `--vad` flag (better accuracy)
- Both are **post-hoc** (run on submitted audio) — don't help with real-time endpointing
- Gateway still needs its own VAD for deciding when to stop buffering and submit

**Server serialization:** whisper-server uses mutex-based serialization — one inference at a time. At family scale (1-3 concurrent speakers), with ~2s per utterance, queuing is manageable. At 10 concurrent users under burst load, wait times compound.

**CPU impact during inference:**
- 4 threads: ~380% CPU (nearly all 4 cores pegged) for 1-2s per utterance
- This is NOT a "lightweight passthrough" — the Pi becomes a compute node during transcription
- Gateway event loop competes for CPU during inference bursts
- Thermal throttling risk: sustained inference above 75°C causes 40-60% performance degradation
- Active cooling (heatsink + fan) is mandatory for sustained local STT

**Accuracy vs Deepgram:**

| System | WER (English clean) | WER (noisy/real-world) |
|--------|--------------------|-----------------------|
| Deepgram Nova-3 | ~5.3-6.8% | ~5-7% (purpose-built) |
| Whisper large-v3 | ~4-5% | ~10-12% |
| Whisper base.en | ~4.3% (clean) | ~12-25% (degrades fast) |
| Whisper tiny.en | ~5.6% (clean) | ~15-40% (noisy) |

For a family home (kids, TV, ambient noise), base.en accuracy degrades significantly vs Deepgram.

**TypeScript integration:**
- **HTTP to whisper-server** (recommended): Clean separation, no native bindings, works with Bun's `fetch`
- **Native bindings** (`whisper-node-addon`): ARM64 prebuilt binaries exist, but Bun N-API compatibility uncertain
- **faster-whisper-server** (Python): Alternative backend, ~10-20% faster on ARM via CTranslate2+OpenBLAS, same HTTP API

**Pros:**
- **Offline capable** — works without internet
- Zero ongoing cost
- Audio never leaves the home network — maximum privacy
- Predictable performance (no network variability)

**Cons:**
- **Significantly worse accuracy** in noisy home environments (2-5x higher WER than Deepgram)
- **1.5-2.5s latency per utterance** (vs 300-500ms cloud) — noticeably slower conversational feel
- **Violates "lightweight passthrough" design** — pegs all 4 CPU cores during inference
- **Serialized processing** — one inference at a time, queuing under concurrent load
- **Thermal throttling** risk under sustained use — requires active cooling
- Not true streaming — must buffer complete utterance before processing
- Gateway needs its own VAD for endpointing (whisper VAD is post-hoc only)
- Max 1-2 concurrent sessions before queuing becomes a UX problem
- No streaming partials — user sees nothing until full transcription completes

**Risk factors:**
- CPU contention with gateway event loop during inference
- Thermal throttling degrades performance unpredictably
- Accuracy on names/commands may be poor enough to frustrate family members
- Model size vs accuracy tradeoff has no great sweet spot on RPi5

---

### Approach C: Hybrid — Cloud Primary + Gateway VAD + Local Fallback

**Description:** Deepgram Nova-3 as primary STT with gateway-side Silero VAD for endpointing enhancement. Whisper.cpp as offline fallback activated by circuit breaker when internet is unavailable.

**Architecture:**
```
Client → [audio frames] → Gateway
                              ↓
                    ┌─── Silero VAD (32ms chunks, ~1ms/chunk on RPi5)
                    │         ↓
                    │    SPEECH_START → start forwarding to STT
                    │    SPEECH_END   → signal utterance complete
                    │
                    ├─── [internet OK?] ──YES──→ Deepgram WS (stream audio)
                    │                              ↓
                    │                   speech_final / UtteranceEnd
                    │
                    └─── [internet DOWN?] ──→ Buffer → whisper-server POST
                                                        ↓
                                                  { text: "..." }
```

**Gateway-side Silero VAD:**
- Model: Silero v5, ~2MB ONNX file
- Input: 16kHz PCM Float32, 512 samples (32ms) per chunk
- Output: speech probability 0.0-1.0 per chunk
- Performance: ~1ms per chunk on RPi5 (~165x real-time on desktop, ~30-50x on RPi5)
- CPU impact: ~3-5% for 1-3 active sessions (10 concurrent all speaking: ~15%)
- Package: `avr-vad` (npm) — wraps onnxruntime-node + bundled Silero v5 ONNX model
- Events: `SPEECH_START`, `SPEECH_CONTINUE`, `SPEECH_END`, `SILENCE`
- ⚠️ `onnxruntime-node` uses N-API — Bun compatibility ~95%, must test on hardware

**Double endpointing strategy (VAD + Deepgram):**
```
Audio → Gateway Silero VAD (32ms chunks)
                ↓
         SPEECH_END event → fire internal speech_done signal
                ↓
      Also wait for Deepgram speech_final or UtteranceEnd
                ↓
      First-wins: whichever arrives first triggers LLM pipeline
```
- Silero VAD: ~300ms silence threshold (10 consecutive silent 32ms chunks)
- Deepgram: `endpointing=300&utterance_end_ms=1000`
- First-wins logic: VAD fires fast in clean audio; UtteranceEnd catches noisy-room cases
- Result: ~300ms endpointing in clean conditions, robust fallback in noisy conditions

**Why gateway-side VAD (not client-side):**
- Single implementation for all 3 clients (Android, iOS, Web)
- Consistent endpointing logic regardless of client
- Client already handles wake-word (Porcupine); adding VAD there means 3 implementations
- Gateway latency cost is minimal (audio already arrives over WebSocket)

**Offline fallback via circuit breaker:**
```typescript
// Circuit breaker: track Deepgram connection health
if (circuitBreaker.isOpen()) {
  // Internet down: buffer audio, POST to whisper-server
  return whisperQueue.add(() => whisperTranscribe(audioBuffer));
} else {
  // Normal: stream to Deepgram
  deepgramConnection.send(audioFrame);
}
```
- whisper-server runs as persistent sidecar: `base.en-q5_0`, 4 threads, `-ac 512`
- Idle: <1% CPU, ~150MB RAM (model loaded, waiting for requests)
- Active: ~380% CPU for 1-2s per utterance
- Accepts degraded experience (2-4s latency, lower accuracy) as "better than dead"
- Max 1-2 concurrent sessions in fallback mode

**Cost optimization from VAD:**
- Deepgram bills on audio seconds sent, not connection time
- Gateway VAD trims silence within active sessions (pre/post speech)
- Savings: ~30-50% off the base bill (~$3-5/month at family scale)
- Not the primary motivation — endpointing quality and noise robustness are the real value

**Phased implementation plan:**
1. **Phase 1 (launch):** Pure Deepgram with tuned endpointing (1-2 days)
2. **Phase 2:** Add gateway Silero VAD for double-endpointing (2-3 days)
3. **Phase 3 (if needed):** Add whisper.cpp offline fallback (3-5 days)

**Pros:**
- Best accuracy (Deepgram) in normal operation
- Robust endpointing via dual VAD + STT service signals
- Offline resilience (degraded but functional)
- Single endpointing implementation for all clients
- Phased — can ship with just Phase 1 and add layers incrementally
- Gateway stays lightweight in normal operation (VAD is ~5% CPU)

**Cons:**
- Most complex implementation (two STT code paths, VAD state machine, circuit breaker)
- N-API dependency for Silero VAD (Bun compatibility risk)
- Whisper fallback is significantly worse experience (users will notice)
- More code to maintain for a personal project
- Full hybrid is ~7-10 days implementation vs 1-2 days for pure cloud

**Risk factors:**
- N-API/onnxruntime-node may not work under Bun — fallback: WebRTC VAD (pure algorithmic, no ONNX)
- Circuit breaker logic complexity (false positives, flapping)
- Two code paths means double the edge cases and testing surface

---

## Analysis

### Accuracy comparison

| System | WER (English, clean) | WER (noisy home) | Streaming partials |
|--------|---------------------|-------------------|-------------------|
| Deepgram Nova-3 | ~5.3% | ~5-7% | Yes (sub-300ms) |
| Whisper base.en (RPi5) | ~4.3% | ~12-25% | No (batch only) |
| Whisper tiny.en (RPi5) | ~5.6% | ~15-40% | No (batch only) |

Deepgram's purpose-built streaming model maintains accuracy in noisy conditions where Whisper degrades rapidly. For a home environment with background noise, this gap is decisive.

### Latency comparison

| Phase | Deepgram Nova-3 | Whisper base (RPi5) |
|-------|-----------------|---------------------|
| First partial | ~150-300ms | N/A (batch) |
| Final transcript | ~300-500ms | ~1.5-2.5s |
| Speech end → LLM call | ~600-1000ms | ~2-4s |

Deepgram is 3-5x faster to final transcript and provides streaming partials that can enable speculative LLM processing.

### Cost comparison

| Approach | Monthly cost (5 users, moderate use) | Free credit runway |
|----------|-------------------------------------|--------------------|
| Deepgram only | ~$10.40 | ~19 months |
| Deepgram + VAD trim | ~$7-8 | ~24 months |
| Whisper only | $0 | N/A |
| Hybrid | ~$7-8 + electricity | ~24 months |

### RPi5 resource impact

| Approach | CPU (normal) | CPU (peak) | RAM added | Thermal risk |
|----------|-------------|-----------|-----------|-------------|
| Deepgram only | ~0% | ~5% (network I/O) | ~0 | None |
| Whisper only | ~0% (idle) | ~380% (inference) | ~150MB | High |
| Hybrid (normal) | ~5% (VAD) | ~10% (VAD + network) | ~20MB (Silero) | None |
| Hybrid (fallback) | ~5% (VAD) | ~380% (whisper) | ~170MB | High |

### Gateway design impact

| Approach | "Lightweight passthrough"? | Complexity |
|----------|--------------------------|------------|
| Deepgram only | ✅ Yes — audio relay only | Low |
| Whisper only | ❌ No — heavy compute node | Low |
| Hybrid (normal) | ✅ Yes — VAD is lightweight | Medium-High |
| Hybrid (fallback) | ❌ No — compute node during outage | Medium-High |

### Connection management recommendation

**Persistent WebSocket per active session.** Deepgram idle connections cost $0. Reconnection adds 100-300ms latency per utterance. For a family assistant with infrequent use, keep 1 connection per active session. Close when session ends (user disconnects or idle timeout). Keepalive every 8-10s during active sessions with silence gaps.

## Recommendation

**Approach C: Hybrid (Cloud Primary + Gateway VAD + Local Fallback)** is the strongest choice, implemented in phases.

**Rationale:**

1. **Deepgram Nova-3 is the clear primary STT.** 3-5x better latency, significantly better noisy-environment accuracy, zero CPU load, true streaming partials. At ~$10/month with 19 months of free credit, the cost is negligible.

2. **Gateway-side Silero VAD adds meaningful value.** Double-endpointing (VAD + Deepgram) provides robust utterance detection in noisy home environments. Single implementation serves all three clients. CPU cost is minimal (~5%).

3. **Local fallback is worth having but not at launch.** Internet outages turn the assistant off entirely without it. Whisper base.en on RPi5 is degraded but functional. Implement after the core pipeline works.

4. **Phased approach manages complexity.** Phase 1 (pure Deepgram) ships in 1-2 days. Phase 2 (VAD) adds 2-3 days. Phase 3 (fallback) adds 3-5 days. Each phase is independently valuable.

5. **Raw WebSocket for Deepgram, not the SDK.** The `@deepgram/sdk` doesn't work with Bun. The streaming protocol is simple enough to implement directly (~100 lines). This also eliminates a dependency.

**Key implementation decisions:**
- Raw Bun WebSocket to Deepgram (not SDK) — avoids Bun compatibility issue
- `endpointing=300&utterance_end_ms=1000` — balanced for conversational speech
- Gateway-side Silero VAD via `avr-vad` (test N-API on Bun; fallback: WebRTC VAD or energy-based)
- whisper-server sidecar (`base.en-q5_0`, HTTP API) for offline fallback — persistent process, gateway POSTs buffered audio
- Circuit breaker pattern for cloud/local switching

## Open Questions

- Does `avr-vad` (onnxruntime-node N-API) actually work under Bun on ARM64? Needs PoC testing.
- ~~Raw WebSocket to Deepgram from Bun — does binary frame transmission work correctly?~~ **Validated in PoC** (`poc/stt-deepgram-raw-ws/`): binary frames, double-endpointing, barge-in reset all work correctly.
- Silero VAD threshold tuning for home environments — what silence duration works best?
- whisper.cpp thermal behavior on RPi5 under sustained load — does active cooling keep it under 75°C?
- Should speculative LLM processing start on high-confidence `is_final` partials before `speech_final`?

---

## Decomposition

The stt-strategy decision area is broken into three sub-areas. Each is independently implementable per the phased plan (Phase 1 → 2 → 3).

### Sub-Area 1: Endpointing (`stt-endpointing`)

**Scope:** How the gateway determines when a user has finished speaking and the accumulated transcript should be flushed to the intelligence pipeline.

**Components:**
1. **Deepgram signal handling** — `speech_final` and `UtteranceEnd` events, first-wins flush logic
2. **Gateway-side Silero VAD** — 32ms chunk processing, `SPEECH_START`/`SPEECH_END` events, silence threshold tuning
3. **Double-endpointing merge** — first-wins between VAD `SPEECH_END` and Deepgram `speech_final`/`UtteranceEnd`
4. **Transcript buffer** — accumulate `is_final` segments, join on flush, reset on barge-in

**Status:** Deepgram-side endpointing validated in PoC (`poc/stt-deepgram-raw-ws/`). VAD-side not yet tested.

**Key decisions:**
- Silence threshold for Silero VAD: 300ms (10 × 32ms chunks) matches `endpointing=300` — is this optimal for noisy homes, or should VAD use a longer window (e.g., 500ms)?
- VAD package: `avr-vad` (Silero v5 via onnxruntime-node) vs WebRTC VAD (pure algorithmic, no ONNX) vs energy-based (simplest, least accurate). N-API/Bun compatibility is the deciding factor.
- Speculative LLM: should high-confidence `is_final` partials trigger speculative classification before endpointing completes? (Potential 200-400ms latency savings, complexity cost.)

**Risks:**
- N-API/onnxruntime-node under Bun: ~95% compatible but not guaranteed. Needs hardware PoC.
- Silero VAD in noisy home: children, TV, pets produce speech-like energy. False positives cause premature flush; false negatives cause delayed flush.
- Double-endpointing race conditions: both signals arrive within the same event loop tick — first-wins must be atomic.

### Sub-Area 2: Provider Integration (`stt-provider-integration`)

**Scope:** The STT provider interface, Deepgram raw WebSocket client, and the abstraction that allows swapping providers.

**Components:**
1. **STT provider interface** — TypeScript interface defining `connect()`, `sendAudio()`, `close()`, event callbacks (`onTranscript`, `onSpeechStart`, `onUtteranceEnd`, `onFlush`)
2. **Deepgram raw WebSocket client** — validated in PoC, ~250 lines, handles auth, binary frames, keepalive, CloseStream
3. **Provider configuration** — YAML config for model, language, endpointing params, API key reference
4. **Connection lifecycle** — persistent WebSocket per session, reconnection on disconnect, idle timeout

**Status:** Core client validated in PoC (`poc/stt-deepgram-raw-ws/`). Interface design and config layer not yet specified.

**Key decisions:**
- Interface shape: should `STTProvider` emit raw events (transcript, speech_started, utterance_end) and let the caller handle buffering, or should it own the buffer and emit flushed utterances? The PoC currently owns the buffer — this is simpler but couples buffering logic to the provider.
- Connection pooling: one Deepgram WS per active session, or a shared connection with multiplexing? Deepgram doesn't support multiplexing, so one-per-session is correct, but need connection limit management for 10 concurrent sessions.
- Reconnection strategy: exponential backoff with jitter, max 3 retries, then circuit breaker opens.

**Risks:**
- 10 concurrent Deepgram WebSocket connections: should work (cloud service scales), but verify no client-side resource issues on RPi5.
- Deepgram API changes: raw WebSocket means no SDK version pinning. Protocol is stable but needs integration test coverage.

### Sub-Area 3: Offline Fallback (`stt-offline-fallback`)

**Scope:** Local whisper.cpp-based STT activated when internet is unavailable, managed by a circuit breaker.

**Components:**
1. **whisper-server sidecar** — persistent process running `base.en-q5_0`, HTTP API on localhost, started via systemd or process manager
2. **Circuit breaker** — tracks Deepgram connection health (open/closed/half-open), switches STT path on failure
3. **Audio buffering for batch** — when in fallback mode, gateway buffers complete utterances (using VAD endpoint) then POSTs WAV to whisper-server
4. **Degraded mode UX** — notify client of degraded mode, adjust expectations (no streaming partials, higher latency)

**Status:** Not yet implemented. Architecture defined in exploration. Phase 3 priority.

**Key decisions:**
- Circuit breaker thresholds: how many consecutive failures to open? How long before half-open probe? Suggested: 3 failures → open, 30s → half-open.
- whisper-server lifecycle: always running (150MB idle RAM) vs on-demand start (~5s cold start)? Always-on is simpler and avoids cold start penalty.
- Audio format for whisper POST: WAV (simple, larger) vs raw PCM with headers (smaller, more code)?
- Concurrency in fallback: whisper-server is serialized (mutex). At 10 concurrent users, queue depth explodes. Should fallback mode cap concurrent sessions or reject new ones?

**Risks:**
- CPU contention: whisper inference pegs all 4 cores for 1-2s, starving the gateway event loop. Mitigations: `nice` priority, CPU affinity, or accept brief event loop stalls.
- Thermal throttling: sustained inference without active cooling degrades performance 40-60%. Mandatory: heatsink + fan.
- Quality gap: users will notice the accuracy and latency degradation. Need clear UX signal ("offline mode — responses may be slower and less accurate").

---

## Test Strategy

### Unit Tests (run in CI, no external services)

| Component | What to test | How |
|-----------|-------------|-----|
| Transcript buffer | Accumulate `is_final` segments, join on flush, empty handling | Pure function tests, no mocks |
| First-wins flush | `speech_final` before `UtteranceEnd`, vice versa, same-tick race | State machine tests with synthetic events |
| Barge-in reset | Buffer clear + flag reset, subsequent utterance works | State machine tests |
| Deepgram message parser | All event types: Results, SpeechStarted, UtteranceEnd, Metadata, Error | Parse JSON fixtures, assert typed output |
| Circuit breaker | State transitions: closed→open→half-open→closed, threshold counts, timeout | Timer-based tests with mock failure injection |
| Provider interface | Contract tests: any STTProvider implementation emits correct event sequence | Interface compliance test suite |

### Integration Tests (mock WebSocket server, like the PoC)

| Scenario | What to validate |
|----------|-----------------|
| Full utterance lifecycle | Audio send → interim → final → speech_final → flush callback with correct text |
| Double-endpointing | VAD SPEECH_END vs Deepgram speech_final race — first-wins under various orderings |
| Multi-segment utterance | Multiple `is_final` segments accumulate correctly before flush |
| Sequential utterances | State resets between utterances, no cross-contamination |
| KeepAlive + CloseStream | Control messages sent at correct intervals, graceful shutdown |
| Binary frame integrity | Frame content and size preserved through WebSocket relay |
| Throughput | ≥500 frames/sec to handle 10 concurrent sessions at 50 frames/sec each |
| Reconnection | Simulate WS disconnect, verify reconnect + session recovery |
| Circuit breaker failover | Simulate N consecutive failures, verify switch to whisper path |

**Already validated in PoC (`poc/stt-deepgram-raw-ws/`):** Tests 1-10 cover binary frames, double-endpointing (both orderings), multi-segment, sequential utterances, barge-in reset, control messages, empty transcripts, and throughput (>500 frames/sec confirmed).

### E2E Tests (requires real services, run manually or in staging)

| Scenario | What to validate |
|----------|-----------------|
| Deepgram live connection | Real audio → real transcript, verify accuracy on known utterances |
| whisper-server local | POST known WAV → verify transcript accuracy |
| Failover round-trip | Kill network → verify circuit breaker opens → whisper picks up → restore network → verify circuit breaker closes |
| Concurrent sessions | 3-5 simultaneous audio streams → verify all get transcripts without crosstalk |
| Noisy environment | Play background noise + speech → verify endpointing doesn't fragment utterances |

### Test Infrastructure

- **Mock Deepgram server:** Already built in PoC (`poc/stt-deepgram-raw-ws/test.ts`). Extract into reusable test fixture.
- **Audio fixtures:** Pre-recorded WAV files of known utterances (clean, noisy, multi-speaker) for consistent regression testing.
- **VAD test harness:** Feed known audio through Silero VAD, assert SPEECH_START/END at expected timestamps.
- **Circuit breaker test clock:** Injectable timer for testing timeout transitions without real delays.
