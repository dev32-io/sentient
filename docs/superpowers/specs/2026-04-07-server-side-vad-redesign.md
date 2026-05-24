# Server-Side VAD Redesign

Amends: `2026-04-06-voice-pipeline-sdk-redesign.md`
Branch: `feature/voice-pipeline-sdk-redesign`

## Problem

Client-side VAD (RMS energy threshold in AudioWorklet) is unreliable:

- Too sensitive to background noise (keyboard, fan, ambient)
- Too low gain on actual speech — misses quiet utterances
- Easily triggered by assistant's own TTS playback bleeding into the mic
- Race conditions between client-side silence timers and Deepgram's `speechFinal` event
- Five consecutive bug-fix commits on this branch, all fighting the same root cause

The root cause: a simple amplitude threshold cannot distinguish speech from noise. Turn boundary decisions belong where the speech intelligence lives — the STT provider.

## Decision

Move turn detection authority from client-side VAD state machine to server-side STT provider (Deepgram). The client becomes a continuous audio source. The gateway determines when speech starts and ends based on the STT provider's built-in voice activity detection.

## Core Principles

1. **SDK = source of truth for the developer.** Developer calls `startVoiceMode()` and receives events. Everything else is invisible.
2. **STT service = abstract black box.** The SDK consumes a `SpeechService` contract. It never knows the concrete provider. Swappable, chainable, expandable.
3. **Gateway is self-protective.** Never trusts the client to handle playback state. Suppresses speech events during its own TTS output regardless of client behavior.
4. **Client-side filter is cost optimization, not logic.** The `VadFilter` gates which audio frames are worth sending. It has zero coupling to the state machine or speech service.

## Architecture: Three Abstraction Layers

```
Layer 1: SDK Public Surface
  Developer sees: startVoiceMode() / stopVoiceMode()
  Developer gets: onSpeechStart, onSpeechEnd, onTranscript, onResponse, onAudioLevel
  Everything else is invisible.

Layer 2: Speech Service Contract
  Interface: SpeechService
    events in:  audio frames (binary)
    events out: speech-start, speech-end, transcript-partial, transcript-final, state
    controls:   dispose
  SDK doesn't know what's behind this.

Layer 3: Gateway + Provider
  Gateway mediates the WebSocket transport.
  Deepgram (or any STT) is the concrete provider behind SttProvider contract.
  Gateway owns suppression logic.
  Gateway emits speech service events to client.
```

Orthogonal to all layers:

```
Local Audio Gate (VadFilter contract)
  Interface: VadFilter
    input:  raw audio frame
    output: { send: boolean, speechProbability: number }
  Implementations: SileroVadFilter (ML), EnergyVadFilter (RMS fallback)
  Purpose: bandwidth/cost optimization only.
  Zero coupling to speech service or state machine.
```

The VadFilter and SpeechService never communicate. The VadFilter gates what goes out. The SpeechService determines what comes back. The SDK's state machine orchestrates both.

## State Machine

Single voice state machine. No separate VAD state machine.

```
                        +----------+
       startVoiceMode() |          | stopVoiceMode()
       ---------------> | inactive | <----------------
                        |          |   (from any state)
                        +----+-----+
                             | START
                             v
                        +----------+
                        |connecting| --- timeout --> error
                        +----+-----+
                             | service: connected
                             v
                  +-----> +----------+
                  |       | listening| (streaming audio, waiting
                  |       +----+-----+  for server speech event)
                  |            |
                  |            | service: speech-start
                  |            v
                  |       +------------+
                  |       |user-speaking| (server detected speech)
                  |       +----+-------+
                  |            |
                  |            | service: speech-end
                  |            v
                  |       +----------+
                  |       |processing| (waiting for LLM + TTS)
                  |       +----+-----+
                  |            | response: audio-start
                  |            v
                  |       +-------------------+
                  |       |assistant-speaking  |
                  |       |(gateway suppresses |
                  |       | speech events)     |
                  |       +----+--------------+
                  |            | response: audio-done
                  +------------+ -> back to listening
```

Key differences from the April 6 spec:

- No `speech-detected`, `trailing-silence`, or debounce states. All speech boundary decisions come from the SpeechService.
- No separate VAD state machine. The 11-state VAD machine is eliminated entirely.
- `listening` means actively streaming audio (through VadFilter). The server tells us when speech starts.
- `assistant-speaking` triggers gateway-side suppression. Gateway doesn't rely on client.
- Barge-in: during `assistant-speaking`, if gateway detects high-confidence speech through suppression, it emits `barge_in.ack` + `vad.speech-start`. Machine transitions to `user-speaking`.
- Error/reconnect: unchanged from April 6 spec.

## Audio Flow

```
CLIENT
  Microphone (getUserMedia, echoCancellation: true)
    | 48kHz
  AudioCapture (web-audio-capture.ts)
    | PCM16 frames
  VadFilter.process(frame) -> { send, speechProbability }
    |-- send=false -> frame dropped (silence/noise, never leaves client)
    |-- send=true  -> frame forwarded to transport
    |-- speechProbability -> emitted as onAudioLevel (cosmetic UI)
    |
  Transport (WebSocket binary)

GATEWAY
  WebSocket receive (binary frames)
    |
  ContinuousSession
    |-- if assistant-speaking && !barge-in -> suppress
    |-- else -> forward to STT provider
    |
  STT Provider (Deepgram, behind SttProvider contract)
    | speech-start, speech-end, transcript-partial, transcript-final
    |
  ContinuousSession applies suppression logic
    | filtered events
  Voice Handler emits to client via WebSocket JSON:
    { type: "vad.speech-start" }
    { type: "vad.speech-end" }
    { type: "transcript.partial", text }
    { type: "transcript.final", text }
    |
  [On speech-end] accumulated transcript -> LLM pipeline
    |
  LLM response -> TTS -> binary audio frames -> client
  Also emits: { type: "response.audio.start" }
              { type: "response.audio.done" }

CLIENT (playback)
  SpeechService adapter (maps WS messages -> SpeechService events)
    |
  Voice State Machine (state transitions)
    |
  SDK public events: onSpeechStart, onSpeechEnd, onTranscript,
                     onResponse, onAudioLevel
```

## Gateway Suppression & Barge-in

The gateway tracks its own playback state. During TTS output, it suppresses incoming speech events from the STT provider to prevent echo-triggered turns.

```
Gateway state:
  isSpeaking = false

On TTS audio start:
  isSpeaking = true
  emit { type: "response.audio.start" } to client

On TTS audio done:
  isSpeaking = false
  emit { type: "response.audio.done" } to client

On STT speech event received:
  if isSpeaking:
    suppress (don't emit vad.speech-start, don't start new turn)
    BUT: check for barge-in condition
  else:
    emit normally
```

Barge-in during suppression uses Deepgram's own confidence scores:

```
On STT transcript during isSpeaking:
  if transcript.confidence > BARGE_IN_THRESHOLD
     && transcript.text.length > 0:
    abort current TTS playback
    abort current LLM generation
    isSpeaking = false
    emit { type: "barge_in.ack" } to client
    emit { type: "vad.speech-start" } to client
    begin new turn with this transcript
```

Suppression is conservative by default. Better to miss a barge-in (user speaks again) than to false-trigger and cut off the assistant. Default `BARGE_IN_THRESHOLD`: 0.85 confidence (tunable per deployment via gateway config).

No local pre-classifier for barge-in. Deepgram is already connected and metered; its built-in SpeechStarted event and confidence scores are more accurate than any local solution. The marginal cost of forwarding audio during suppression windows is negligible (~$0.08-0.15/day for typical usage).

## Contracts

### VadFilter

```typescript
interface VadFilter {
  init(): Promise<void>
  process(frame: Int16Array): VadFilterResult
  dispose(): void
}

interface VadFilterResult {
  send: boolean
  speechProbability: number
}
```

Two implementations:

| | SileroVadFilter | EnergyVadFilter |
|---|---|---|
| When | Desktop Chrome, Firefox, Edge, Safari 16.4+ | iOS Safari, or Silero fails to load |
| How | @ricky0123/vad-web FrameProcessor + Silero ONNX | RMS energy threshold |
| Size | ~12.5 MB first load (cached) | Zero |

Platform selection: try Silero first, fall back to Energy on failure. No explicit platform sniffing — future-proof for when iOS fixes WASM support.

### SpeechService

```typescript
interface SpeechService {
  connect(): Promise<void>
  disconnect(): void
  dispose(): void

  sendAudio(frame: Int16Array): void

  on(event: 'speech-start', cb: () => void): void
  on(event: 'speech-end', cb: () => void): void
  on(event: 'transcript-partial', cb: (text: string) => void): void
  on(event: 'transcript-final', cb: (text: string) => void): void
  on(event: 'state', cb: (state: ServiceState) => void): void
}

type ServiceState = 'connecting' | 'connected' | 'disconnected' | 'error'
```

Single implementation for now: `WebSocketSpeechService` — maps gateway WS messages to contract events.

## Protocol Changes

New gateway -> client messages:

```typescript
{ type: "vad.speech-start" }   // STT provider detected speech
{ type: "vad.speech-end" }     // STT provider detected end of speech
```

Removed from protocol:

```typescript
{ type: "utterance.start" }    // client no longer sends these
{ type: "utterance.end" }      // gateway determines turn boundaries
{ type: "utterance.cancel" }   // no longer needed
```

Client no longer drives turn boundaries. Gateway listens to its own STT provider.

## Codebase Impact

### New components

| Component | Location |
|---|---|
| VadFilter interface | shared/web-sdk/src/ |
| SileroVadFilter | shared/web-sdk/src/ |
| EnergyVadFilter | shared/web-sdk/src/ |
| SpeechService interface | shared/web-sdk/src/ |
| WebSocketSpeechService | shared/web-sdk/src/ |
| vad.speech-start / vad.speech-end messages | shared/protocol/ |

### Modified components

| Component | Change |
|---|---|
| Voice state machine (voice-client.ts) | Simplified: reacts to SpeechService events, not VAD callbacks. Remove speech-detected, trailing-silence, debounce states. |
| Audio capture (web-audio-capture.ts) | Integrate VadFilter in send path. Remove RMS VAD event emission. |
| Capture worklet (capture-worklet.ts) | Remove VAD logic. Pure PCM capture pipe. |
| ContinuousSession (gateway) | Own turn boundaries from STT events. Add suppression during TTS. Emit vad.speech-start/end. |
| continuous-voice-handler.ts (gateway) | Remove handleUtteranceStart/End. Server-driven turn flow. |
| Protocol messages (messages.ts) | Add vad.speech-start/end. Remove utterance.start/end/cancel. |

### Deleted components

| Component | Why |
|---|---|
| vad-state-machine.ts | Entire file. Replaced by VadFilter + SpeechService. |
| voice-effect-handler.ts (VAD dispatcher) | No VAD state machine to dispatch to. |
| VAD logic in capture-worklet.ts | RMS threshold, speaking state — all removed. |
| utterance.start/end/cancel messages | Client no longer drives turn boundaries. |
| Onset debounce / trailing silence timers | Server-side STT handles timing. |

### Unchanged

| Component | Why |
|---|---|
| Transport (transport.ts) | Still sends binary + JSON over WebSocket. |
| Playback adapter / worklet | TTS playback path unchanged. |
| LLM pipeline, TTS pipeline (gateway) | Downstream of turn boundaries, input contract unchanged. |
| Auth, session management | Orthogonal. |
| SDK public API | Developer surface unchanged. |
| Error UX state machine | Unchanged from April 6 spec. |

## Cost Analysis

For 3 hours of conversation (~$8.50 total):

| Service | Cost | % |
|---|---|---|
| Fish Audio TTS | $6.93 | 82% |
| Deepgram Nova-3 STT | $1.39 | 16% |
| OpenRouter LLM (70% Haiku / 30% Sonnet) | $0.18 | 2% |

Extra Deepgram cost from streaming during suppression windows: ~$0.08-0.15/day. Negligible.

TTS dominates cost. STT-based barge-in detection adds no meaningful expense.

## Dependencies

| Package | Purpose | Size |
|---|---|---|
| @ricky0123/vad-web | Silero VAD model for client-side audio gate | ~12.5 MB (cached) |

No new gateway dependencies. Deepgram's existing speech detection events are sufficient.

## Future Enhancement Paths

- **Gateway-side Silero VAD (sherpa-onnx):** When added for double-endpointing, naturally serves as barge-in pre-classifier at zero additional cost. ARM64 prebuilts available.
- **Local STT fallback:** SpeechService contract supports a future `LocalSpeechService` that runs entirely on-device (Whisper.cpp / Vosk).
- **Composite services:** `CompositeSpeechService` could try local first, fall back to gateway.
- **Additional STT providers:** Same SttProvider gateway contract, new implementation.
