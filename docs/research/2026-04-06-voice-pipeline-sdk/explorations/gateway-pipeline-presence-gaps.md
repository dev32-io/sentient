# Explore: Gateway Pipeline Presence Gaps

## Objective

Map the complete timeline from every user action to every system response in the gateway pipeline, quantifying every silent gap where the user receives no feedback. This extends the rethink analysis with precise code-level tracing and latency measurements.

## Methodology

Traced every `await`, generator yield point, and message send in the production gateway code. Categorized gaps by:
- **Duration**: measured/estimated latency range
- **Detectability**: can the system know it's in the gap?
- **Current mitigation**: does any feedback exist today?
- **PoC coverage**: does the state machine model this gap?

## Complete Timeline: Voice Turn Lifecycle

### Segment A: Connection Phase

```
[User clicks "Connect"]
  │
  ├─ T0: WS connection established (ws-server.ts)
  │     → Client receives: WS open event only
  │
  ├─ T1: Auth token verified (ws-server.ts)
  │     → Client receives: nothing
  │     ⏱ ~10-50ms
  │
  ├─ T2: handleVoiceStart() → session.startRecording() (voice-handlers.ts:33)
  │     → doConnect() called (voice-session.ts:61)
  │     → sttProvider.connect() AWAITED (voice-session.ts:61-62)
  │     → Client receives: NOTHING
  │     ⏱ 200ms-3000ms (Deepgram WS handshake + config)
  │     ⚠ NO TIMEOUT — can hang indefinitely
  │
  ├─ T3: ttsProvider.connect() AWAITED (voice-session.ts:77-78)
  │     → Client receives: NOTHING (still waiting)
  │     ⏱ 200ms-2000ms (Fish Audio WS handshake)
  │     ⚠ NO TIMEOUT — can hang indefinitely
  │
  └─ T4: Both providers ready, startRecording() returns
       → Client receives: implicit readiness (can start sending audio)
```

**GAP A: Connection silence** — 400ms to 5000ms+ with NO user feedback.
- User stares at UI with no indication system is working
- If either provider hangs, user waits forever
- PoC emits: `SEND_STATUS: "connecting"` → `SEND_STATUS: "ready"`

### Segment B: Speaking Phase

```
[User speaks / VAD triggers]
  │
  ├─ T5: utterance.start / audio.start received
  │     → Client receives: nothing from gateway
  │     ⏱ ~0ms (WS message latency only)
  │
  ├─ T6: Audio chunks flow → session.sendAudio() (voice-session.ts:89-98)
  │     → If connectPromise still pending: buffered in earlyAudioBuffer (voice-session.ts:93)
  │     → If connected: forwarded to sttProvider.sendAudio()
  │     → Client receives: NOTHING
  │     ⚠ Early audio buffer leak if connectPromise rejects (voice-session.ts:50)
  │
  ├─ T7: STT emits partial transcripts (Deepgram interim_results: true)
  │     → readNextFinalTranscript() FILTERS these out (voice-session.ts:131-138)
  │     → transcript.partial message type EXISTS in protocol but NEVER SENT
  │     → Client receives: NOTHING
  │     ⏱ Partials arrive every 200-500ms while speaking
  │
  └─ T8: More audio chunks... (repeat T6-T7)
```

**GAP B: Discarded partials** — Entire speaking phase produces no gateway→client messages.
- User has zero confirmation their speech is being recognized
- Deepgram is producing partials that could show "You said: ..." in real-time
- Infrastructure exists (message type defined, provider configured) but wiring is missing
- voice-session.ts:131 specifically skips `isFinal: false` events
- PoC emits: `RELAY_PARTIAL_TRANSCRIPT` on every `TRANSCRIPT_PARTIAL` event

### Segment C: Post-Speech Finalization

```
[User stops speaking / VAD triggers end / button release]
  │
  ├─ T9: utterance.end / audio.end received
  │     → session.finishAudio() called (voice-handlers.ts:125)
  │     → sttProvider.finalize() called
  │     → Client receives: NOTHING
  │
  ├─ T10: Waiting for STT to emit isFinal: true transcript
  │      → readNextFinalTranscript() blocks (voice-handlers.ts:46)
  │      → Client receives: NOTHING
  │      ⏱ 200ms-2000ms (STT finalization latency)
  │      ⚠ NO TIMEOUT — can hang INDEFINITELY if STT drops
  │      ⚠ This is the MOST CRITICAL silent gap
  │
  ├─ T11a: [Happy path] Final transcript arrives
  │       → transcript.final sent to client (voice-handlers.ts:136)
  │       → Client finally receives something
  │
  └─ T11b: [Empty path] No transcript / empty string
        → readTranscriptOrNull() returns null
        → handleVoiceEnd() returns early
        → Client receives: NOTHING — no error, no retry prompt
        → User has no idea what happened
```

**GAP C1: Post-speech silence** — 200ms to INFINITE with NO user feedback.
- Most dangerous gap — no timeout means potential infinite hang
- User doesn't know if system heard them or is broken
- PoC emits: `SEND_STATUS: "processing"` immediately, 5s timeout guard

**GAP C2: Empty transcript silence** — User spoke but STT returned nothing.
- Production: silent return, no feedback
- PoC: does NOT model this (gap in both)
- Proposed: `TRANSCRIPT_EMPTY` event → "I didn't catch that"

### Segment D: LLM Processing

```
[Final transcript received]
  │
  ├─ T12: Context assembled, llmProvider.stream() called
  │      → StreamingOverlap created (streaming-overlap.ts:29)
  │      → LLM consumer starts in background
  │      → Client receives: transcript.final only (from T11a)
  │      ⏱ ~0ms (just function calls)
  │
  ├─ T13: Waiting for first LLM token
  │      → streaming-overlap.ts:29 runLLMConsumer() running
  │      → sentence-aggregator.ts waiting for tokens
  │      → Client receives: NOTHING
  │      ⏱ 500ms-3000ms (model dependent, prompt size dependent)
  │      ⚠ NO TIMEOUT on first token arrival
  │
  ├─ T14: First LLM tokens arrive
  │      → sentence-aggregator.ts:133 processes tokens
  │      → text.delta sent to client (voice-turn.ts:54)
  │      → Client receives: text.delta (first real-time feedback!)
  │
  ├─ T15: Waiting for sentence boundary
  │      → sentence-aggregator.ts:155 waitForItem() blocks
  │      → Text deltas continue flowing to client
  │      → Client receives: text.delta (text is the indicator here)
  │      ⏱ 0ms-2000ms (depends on sentence length and LLM speed)
  │      Note: 2s flush timer in sentence-aggregator.ts:3 as safety valve
  │
  └─ T16: Sentence boundary detected → sentence queued
```

**GAP D: LLM thinking silence** — 500ms to 3000ms with NO feedback between transcript.final and first text.delta.
- User sees their transcript appear, then nothing while LLM processes
- No "thinking" indicator, no typing animation, nothing
- PoC emits: `SEND_STATUS: "thinking"` immediately on LLM start, 30s timeout

### Segment E: TTS Synthesis & Audio Streaming

```
[First sentence ready]
  │
  ├─ T17: ttsProcessor.synthesizeSentence() called (streaming-overlap.ts:37)
  │      → Client receives: text.delta still flowing
  │      ⏱ 100ms-1000ms for first TTS chunk
  │
  ├─ T18: First TTS audio chunk arrives
  │      → audioStartCallback() called (streaming-overlap.ts:40-42)
  │      → audio.start sent to client (voice-turn.ts:59)
  │      → First audio.frame sent (voice-turn.ts:63)
  │      → Client receives: audio.start + audio.frame
  │
  ├─ T19: Audio streaming continues
  │      → Subsequent audio.frames yielded as TTS produces them
  │      → Text.delta events interleaved (voice-turn.ts:50-55)
  │      → Client receives: continuous audio + text
  │
  ├─ T20: Sentence N complete, sentence N+1 synthesis starts
  │      → SEQUENTIAL — streaming-overlap.ts:34 loops sentences one at a time
  │      → Brief gap between sentences (~50-200ms)
  │      → Client receives: continuous audio (frames from next sentence)
  │
  └─ T21: Last audio chunk, TTS complete
       → audio.done sent to client
       → Client receives: audio.done
```

**GAP E: Minor inter-sentence gaps** — 50-200ms between sentences, masked by audio buffering on client.
- Generally acceptable — audio playback buffer covers this
- Short responses (<1 sentence) have 0-2s aggregator delay before any audio

### Segment F: Turn Completion

```
[All audio sent]
  │
  ├─ T22: voice-turn.ts generator completes
  │      → streamVoiceTurnEvents() returns (voice-handlers.ts:92)
  │      → History appended
  │      → Client receives: audio.done (from T21)
  │
  └─ T23: handleVoiceEnd() returns
       → Client receives: NOTHING — no "ready" signal
       → User must infer they can speak again
```

**GAP F: Post-turn readiness** — No explicit "ready for next utterance" signal.
- Client must infer from audio.done that system is ready
- In continuous mode, this ambiguity is worse — user doesn't know if mic is active
- PoC emits: `SEND_STATUS: "ready"` on TURN_COMPLETE

### Segment G: Barge-In

```
[User speaks during assistant response]
  │
  ├─ T24: barge_in message received
  │      → voiceSession.bargeIn() called
  │      → AbortController.abort() fires
  │      → Client receives: NOTHING — no acknowledgment
  │
  ├─ T25: Generators terminate (streaming-overlap, voice-turn)
  │      → TTS connection may need cleanup
  │      → Client receives: audio stops (implicit)
  │      ⏱ 10-100ms for abort propagation
  │
  └─ T26: New utterance begins
       → prepareForNewTurn() called
       → Client receives: NOTHING — no "listening" status
```

**GAP G: Barge-in acknowledgment** — 10-100ms with no explicit confirmation.
- User must infer from audio stopping that barge-in was received
- If TTS cleanup is slow, audio may stutter briefly
- PoC emits: `ABORT_TURN` effect → `SEND_STATUS: "ready"` → `SEND_STATUS: "listening"`

### Segment H: Provider Drop (Failure Path)

```
[Provider connection drops mid-turn]
  │
  ├─ T?: STT WebSocket closes during receiving-audio
  │     → transcripts() generator may throw or hang
  │     → Client receives: NOTHING
  │     ⚠ NO detection mechanism in voice-session.ts
  │     ⚠ NO reconnection logic
  │     ⚠ Pipeline HANGS — user waits forever
  │
  ├─ T?: TTS WebSocket closes during streaming-response
  │     → synthesize() generator throws
  │     → Error captured in streaming-overlap.ts
  │     → Error propagation is indirect and delayed
  │     → Client may receive: partial audio then silence
  │
  └─ T?: LLM stream errors
       → stream() generator throws
       → Caught in streaming-overlap.ts runLLMConsumer()
       → Client receives: error only after TTS stage notices no more tokens
```

**GAP H: Provider failure silence** — INDEFINITE with NO feedback.
- Most severe gap — system appears frozen to user
- No retry, no error message, no timeout in production
- PoC emits: `SEND_STATUS: "reconnecting"` → retry → `SEND_ERROR` if exhausted

## Gap Severity Matrix

| Gap | Segment | Duration | Frequency | User Impact | Production Mitigation | PoC Coverage |
|-----|---------|----------|-----------|-------------|----------------------|--------------|
| A: Connection silence | A | 400ms-5s+ | Every session | High — first impression | None | Full |
| B: Discarded partials | B | Entire speech | Every utterance | High — no recognition feedback | None (infra exists) | Full |
| C1: Post-speech hang | C | 200ms-∞ | Every utterance | Critical — potential infinite | None, no timeout | Full (5s guard) |
| C2: Empty transcript | C | N/A | ~5% of utterances | Medium — silent failure | None | Missing |
| D: LLM thinking | D | 500ms-3s | Every turn | High — dead air | None | Full (30s guard) |
| E: Aggregator delay | E | 0-2s | Short responses only | Low — text covers | 2s flush timer | Partial |
| F: Post-turn readiness | F | N/A | Every turn | Medium — ambiguous state | None | Full |
| G: Barge-in ack | G | 10-100ms | When user interrupts | Low — audio stops implicitly | None | Full |
| H: Provider drop | H | Indefinite | Rare but catastrophic | Critical — system freezes | None | Full |

## Worst-Case Silent Gap Chain

In the worst realistic scenario, the user experiences:

```
T0: Opens voice mode                    → SILENCE (Gap A: 3s)
T3: Starts speaking                     → SILENCE (Gap B: entire speech, no partials)
T8: Stops speaking                      → SILENCE (Gap C1: 2s waiting for STT)
T10: Transcript received                → SILENCE (Gap D: 2s waiting for LLM)
T12: First text.delta arrives           → Text visible (gap ends)
T13: Waiting for sentence boundary      → Text visible but NO AUDIO (Gap E: 1s)
T14: First audio frame                  → Audio playing (good)
```

**Total silent time before any feedback: ~7 seconds** in realistic worst case.
**Total time to first audio: ~8 seconds** in realistic worst case.

In production failure case (STT drops, no timeout): **infinite hang after user stops speaking**.

## Key Findings Beyond Rethink Analysis

1. **Early audio buffer leak** (voice-session.ts:50): If `connectPromise` rejects, buffered audio chunks are lost with no error sent to client. This is a silent data loss gap not covered in the rethink.

2. **Sequential provider connection** (voice-session.ts:61-78): STT and TTS are connected sequentially, not in parallel. This doubles the connection gap unnecessarily. Both could connect concurrently.

3. **Sentence aggregator 2s flush is the only timeout in the entire pipeline** (sentence-aggregator.ts:3): The `DEFAULT_FLUSH_TIMEOUT_MS = 2000` is the ONLY timeout guard in production code. Every other wait point has no timeout.

4. **Text.delta acts as accidental presence** (voice-turn.ts:54): The only reason Gap D doesn't extend to first audio is that text tokens are emitted as they arrive. Without text.delta, the gap from end-of-speech to first-audio would be 3-7 seconds of pure silence.

5. **LLM consumer error is silently swallowed** (streaming-overlap.ts:57-62): The finally block awaits `llmConsumerPromise` but error handling is for cleanup only. If the LLM throws after some tokens, remaining audio may play but the turn is truncated without notice.

6. **No heartbeat/keepalive on any provider connection**: Once connected, there's no way to detect a hung provider vs a slow provider. A connection that stops sending data looks identical to one that's processing slowly.

## Recommendations Prioritized by Impact

### P0 — Critical (Prevent system hangs)
1. Add timeout guards to `readNextFinalTranscript()` and provider connections
2. Add provider drop detection (WS close event handling)
3. Emit `status.processing` immediately on utterance.end

### P1 — High (Eliminate dead air)
4. Relay partial transcripts during speech (wire existing infrastructure)
5. Emit `status.thinking` before first LLM token
6. Emit `status.connecting` during provider setup
7. Connect STT and TTS in parallel, not sequentially

### P2 — Medium (Polish UX)
8. Emit `status.ready` after turn completion
9. Handle empty transcripts with user-friendly message
10. Add barge-in acknowledgment message

### P3 — Low (Optimization)
11. Reduce sentence aggregator flush from 2s → 1s
12. Add provider keepalive/heartbeat monitoring
13. Fix early audio buffer leak on connection failure
