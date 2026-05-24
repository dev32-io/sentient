# Client-Side VAD Alternative: Gateway-Delegated VAD ("always-stream")

## Approach Summary

**Invert the responsibility.** Instead of the client detecting speech boundaries and sending `audio.start`/`audio.end`, the client streams audio continuously and the gateway performs all speech detection server-side. The client becomes a thin audio transport with minimal local intelligence.

**Core idea:** Client opens mic → streams all audio → gateway runs Silero VAD (or Deepgram's built-in endpointing) → gateway sends `vad.speech_start` / `vad.speech_end` events back to client → client updates UI state.

## Architecture

```
Client (thin):
  getUserMedia → CaptureWorklet → WebSocket binary stream (always flowing)
                                    ↑ receives JSON events
                                    ├─ vad.speech_start   → show "Listening..."
                                    ├─ vad.speech_end     → show "Processing..."
                                    ├─ transcript.partial  → show partial text
                                    ├─ transcript.final    → show final text
                                    ├─ response.start      → show "Speaking..."
                                    └─ response.done       → back to idle

Gateway (smart):
  WebSocket binary → Silero VAD → speech boundaries
                   → Deepgram STT → transcripts
                   → LLM → response
                   → TTS → audio back
```

### Client State Machine (Simplified)

Only 6 states instead of 11:

```
inactive → streaming → user-speaking → processing → assistant-speaking → streaming
                                                          ↓ (barge-in)
                                                     interrupting → user-speaking
```

| State | Entry condition | User sees |
|-------|----------------|-----------|
| inactive | SDK not started | Nothing |
| streaming | Mic on, audio flowing, no speech detected | "Ready..." (subtle) |
| user-speaking | Gateway sent `vad.speech_start` | "Listening..." |
| processing | Gateway sent `vad.speech_end` | "Thinking..." |
| assistant-speaking | Gateway sent `response.start` | "Speaking..." |
| interrupting | User speaks during assistant (gateway detects) | Barge-in |

**Eliminated states from Approach D:**
- `requesting-mic` — collapsed into `inactive → streaming` (mic request is a one-shot async op, not a persistent state)
- `speech-detected` (onset debounce) — gateway handles internally
- `trailing-silence` — gateway handles silence timeout internally

### Protocol Changes

Client→Gateway messages:
- `session.start` — initiate voice session
- Binary frames — raw audio (always flowing while in streaming+)
- `barge_in` — only in PTT mode, or client can omit and let gateway detect
- `session.end` — tear down

Gateway→Client messages (new):
- `vad.speech_start` — gateway detected speech onset
- `vad.speech_end` — gateway detected speech offset (silence timeout elapsed)
- All existing: `transcript.partial`, `transcript.final`, `response.start`, `response.audio`, `response.done`

## Comparison with Approach D (Pluggable Detector Interface)

| Dimension | Approach D (Client VAD) | Alternative (Gateway VAD) |
|-----------|------------------------|--------------------------|
| **Client complexity** | 11 states, 17 events, pluggable detector interface, onset debounce, trailing silence | 6 states, 8 events, no detection logic |
| **Bundle size** | 0 (energy) or +6MB (Silero) | 0 — no VAD code in client |
| **UX feedback latency** | <1ms (local detection) | 50-200ms (round trip to gateway) |
| **Bandwidth** | Gated — only send audio during speech | Always streaming — ~96KB/s @ 48kHz 16-bit mono |
| **VAD accuracy** | Depends on client env (energy = poor in noise, Silero = good but heavy) | Consistently high — Silero on server, no WASM constraints |
| **Server cost** | None for VAD | CPU for Silero inference per connected client |
| **Platform portability** | Must implement VAD per platform (web, iOS, Android) | One server implementation, all clients benefit |
| **Offline/edge** | Works without server (energy VAD) | Requires server connection for any VAD |
| **Barge-in latency** | <1ms detection + network for barge_in msg | 50-200ms detection + internal routing |
| **Configuration** | SDK consumer tunes thresholds per deployment | Gateway admin tunes once, all clients get same behavior |
| **Testing** | Must test VAD detectors + state machine + integration | Simpler client tests; VAD testing centralized on server |

## Strengths

### 1. Dramatically simpler client SDK
The #1 goal is "SDK = magic black box, <50 lines." Gateway-delegated VAD makes the client SDK almost trivially simple:

```typescript
const client = new VoiceClient({ url: "wss://gateway.example.com" });
client.on("state", (state) => updateUI(state)); // 6 states, not 11
client.on("transcript", (t) => showTranscript(t));
client.on("audio", (chunk) => playAudio(chunk));
await client.start(); // opens mic, starts streaming
```

No VAD config, no threshold tuning, no detector plugins, no mode switching. The SDK is truly a black box.

### 2. Single VAD implementation across all platforms
Web, iOS, Android, Electron — all get the same VAD behavior. No per-platform VAD detector implementation. No "energy VAD works on Chrome but not Safari" issues.

### 3. Better VAD accuracy at no client cost
Server runs Silero (or better) without WASM constraints, SharedArrayBuffer requirements, or bundle size concerns. Every client gets ML-grade detection.

### 4. Gateway has more context for speech detection
Gateway can correlate VAD with STT partial results — e.g., if Deepgram is returning words while Silero says "silence," the gateway can override. This cross-signal fusion is impossible with client-side-only VAD.

### 5. Centralized tuning
Threshold adjustments, model upgrades, new detection strategies — all deploy server-side. No SDK version bump needed. No waiting for app store review.

## Weaknesses

### 1. UX feedback latency (critical)
**This is the biggest problem.** With client-side VAD, the user sees "Listening..." within 1ms of speaking. With gateway-delegated VAD, there's a 50-200ms round trip before the client knows speech started.

- 50ms: imperceptible to most users
- 100ms: noticeable but acceptable
- 200ms: feels sluggish — user starts speaking, UI still says "Ready..."

**Mitigation: Hybrid hint.** Client sends an energy-level hint (above/below simple threshold) alongside audio. This isn't authoritative VAD — it's a UI optimization. Client shows "might be speaking" immediately; gateway confirms/denies within 100ms.

```typescript
// Client-side: minimal energy gate for instant UI feedback
const rms = computeRMS(batch);
if (rms > HINT_THRESHOLD && state === "streaming") {
  showTentativeListening(); // Immediate UI feedback
}
// Gateway confirmation arrives 50-200ms later:
// vad.speech_start → confirm to "Listening..."
// (no event) → revert to "Ready..."
```

This hybrid adds some client complexity but far less than full client-side VAD.

### 2. Bandwidth cost
Always-streaming at 48kHz/16-bit = 96KB/s = ~5.6MB/min = ~345MB/hour.

- LAN/WiFi: negligible
- 4G/5G: manageable but noticeable on metered connections
- Developing regions / poor connectivity: problematic

**Mitigation: Client-side energy gate.** Only stream when energy exceeds a very low threshold (catch all speech, including whispers). This isn't VAD — it's a bandwidth optimization. Threshold set so low that false negatives are near-zero.

```typescript
// Only send audio when there's ANY sound (not silence)
if (rms > NOISE_FLOOR_THRESHOLD) {
  ws.sendBinary(pcmData);
}
```

With typical silence ratio of 60-80%, this cuts bandwidth to ~20-40KB/s average.

### 3. Server CPU cost
Silero VAD on server per connected client:
- ~3-5ms per 32ms frame per client = ~10-15% CPU per client
- 100 concurrent clients ≈ 10-15 CPU cores for VAD alone
- Need to factor into scaling / cost model

**Mitigation:** Use Deepgram's built-in VAD/endpointing (already paid for with STT subscription) instead of running separate Silero. Deepgram's `speech_final` and `UtteranceEnd` events provide speech boundaries as a side effect of STT.

This is a key insight: **if you're already sending audio to Deepgram for STT, you get VAD for free.** The gateway already connects to Deepgram — just surface its speech boundary events.

### 4. Barge-in latency
Client-side VAD can trigger barge-in in <1ms. Gateway-delegated VAD adds round-trip latency (50-200ms). In practice:
- User starts speaking over assistant
- Audio arrives at gateway 25-100ms later
- Gateway VAD detects speech 5-30ms later  
- `vad.speech_start` sent back 25-100ms later
- Total: 55-230ms before client knows to stop playback

**Mitigation:** Client-side echo detection for barge-in only. If mic picks up significant energy while assistant is speaking AND echo cancellation reports residual signal, assume barge-in immediately. This is a narrow, specific check — not full VAD.

### 5. Offline mode impossible
If the server is down, no VAD = no voice. Client-side energy VAD at least provides a degraded experience.

**Mitigation:** Fallback to PTT mode when disconnected. No auto-detection, but user can still manually trigger speech.

### 6. Push-to-talk mode becomes awkward
PTT is inherently client-side. If the client has no VAD, PTT still works (button press = `audio.start`, release = `audio.end`). But the two modes have very different client code paths:
- VAD mode: stream continuously, react to gateway events
- PTT mode: stream on press, stop on release, don't wait for gateway VAD

This asymmetry is manageable but means the "single simple client" story breaks slightly.

## Edge Case Analysis

### Brief pause mid-sentence
- Client streams continuously — no gap in audio
- Gateway Silero/Deepgram handles pause internally (silence timeout)
- **Better than client VAD:** no risk of client prematurely ending the utterance

### Cough/sneeze
- Audio goes to gateway, Silero classifies as non-speech
- No client-side false trigger
- **Better than energy VAD:** ML accuracy on server

### Background TV
- Audio goes to gateway, Silero detects TV speech
- **Same problem as client Silero VAD** — can't distinguish user from TV
- But: gateway can correlate with STT. If Deepgram returns transcript that doesn't match conversation context, gateway can suppress.

### Double utterance
- Gateway detects two speech segments, handles utterance boundary
- Client just shows state transitions as gateway events arrive
- **Cleaner than client VAD:** no client-side debounce/merge decisions

### WebSocket drop during speech
- Client detects WS close, transitions to error state
- Audio buffered on client during reconnect? No — audio is ephemeral, just reconnect and re-stream
- **Simpler than client VAD:** no question about "what happens to buffered audio and in-flight VAD state"

### Echo during assistant speaking
- Gateway receives echo, but gateway KNOWS it's currently playing audio
- Gateway can apply echo suppression or ignore VAD triggers during own playback
- **Better than client VAD:** gateway has authoritative knowledge of what's being played

## Interaction with Other Topics

### SDK State Machine
Dramatically simplified. The state machine has fewer states, fewer events, fewer transitions. Less testing surface, less configuration, less documentation.

### SDK-Gateway Contract
More events flow gateway→client (vad.speech_start, vad.speech_end). Contract is slightly larger but client implementation is simpler.

### Gateway Pipeline
More responsibility on gateway. VAD becomes a pipeline stage. Gateway runs: Audio → VAD → STT → LLM → TTS. The VAD stage is new but architecturally clean — it's just another stateless processor.

### Codec Negotiation
No interaction — audio is always streamed regardless of codec. Codec negotiation is orthogonal.

### Testing Strategy
Client testing: much simpler (no VAD detector testing). Gateway testing: must test VAD stage, but this is a single implementation vs N platform implementations.

### Error UX
Fewer client-side error scenarios (no VAD initialization failure, no WASM load failure, no SharedArrayBuffer missing). Server-side VAD errors surface as gateway events.

## Viability Assessment

**Would this approach transfer to the real codebase?**

Yes, with the hybrid-hint mitigation. The pure "gateway-only" version has a UX latency problem. But with a minimal client-side energy hint for instant UI feedback + gateway confirmation, the approach is viable and arguably superior for SDK simplicity.

The key insight is that **the existing codebase already streams audio to Deepgram**, which already provides speech boundary events. The gateway-delegated approach leverages what's already paid for rather than duplicating detection on the client.

**Best fit scenarios:**
- SDK deployed across many platforms (web + mobile + desktop) — single server VAD instead of N implementations
- Environments where bundle size matters (mobile web, PWA)
- Teams that want zero client-side configuration

**Poor fit scenarios:**
- Offline-first applications
- Very low latency requirements (<50ms barge-in)
- Metered/expensive network connections
- Edge deployments where server round-trip is >200ms

## Recommendations

1. **Name this approach: `gateway-delegated-vad-with-hints`** — pure gateway VAD is too latency-sensitive; the energy hint hybrid resolves the UX gap.

2. **Leverage Deepgram's existing VAD** rather than running separate Silero on server — it's already paid for and eliminates server CPU concern.

3. **Client energy hint** should be dead simple: RMS > threshold → "tentative listening" UI. No debounce, no state machine, no onset frames. Just a visual hint that gets confirmed or reverted by gateway.

4. **PTT mode remains fully client-side** — no gateway VAD needed. This is the correct asymmetry.

5. **Bandwidth mitigation** via noise-floor gate is essential for production use. Threshold should be very conservative (catch all speech including whispers).

## Open Questions

- What's the P99 latency for Deepgram's speech_final event from speech onset? If it's <100ms, the UX concern largely disappears.
- Can we measure echo cancellation quality at runtime to auto-switch between client-hint barge-in and gateway-only barge-in?
- Should the gateway send continuous VAD probability (0-1) for client-side visualization, or just binary start/stop events?
