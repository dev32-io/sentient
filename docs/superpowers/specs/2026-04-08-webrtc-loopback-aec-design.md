# WebRTC Loopback AEC Playback Adapter — Design Spec

**Date:** 2026-04-08
**Branch:** `feature/voice-pipeline-sdk-redesign`

## Goal

Replace AudioContext-based TTS playback with WebRTC loopback playback so the browser's built-in AEC (Acoustic Echo Cancellation) recognizes TTS audio and subtracts it from the microphone input. This eliminates false barge-in from TTS echo without any pipeline changes.

## Problem

The browser's `echoCancellation: true` on `getUserMedia` only cancels audio from WebRTC peer connections (remote participant audio). Our TTS plays through a local `AudioContext` — the browser AEC doesn't know it exists. Deepgram's VAD detects the TTS echo as human speech, causing self-barge-in.

## Solution: WebRTC Loopback

Route TTS audio through a local `RTCPeerConnection` loopback:

```
TTS audio frames (Float32Array)
    ↓
AudioContext → MediaStreamDestination → localPeer.addTrack()
    ↓ (local SDP offer/answer exchange)
remotePeer.ontrack → <audio> element.play()
    ↓
Speakers (browser AEC now has reference signal)
    ↓
Browser AEC subtracts TTS from getUserMedia mic input
```

## Implementation

### File: `web/src/adapters/web-audio-playback.ts`

Full rewrite of internals. The `AudioPlaybackAdapter` interface is unchanged.

### `init()`

1. Check `RTCPeerConnection` exists — throw `"WebRTC not supported. Use a modern browser (Chrome, Firefox, Safari, Edge)."` if missing
2. Create `AudioContext` with target sample rate
3. Create `MediaStreamDestination` node on the AudioContext — this converts scheduled audio buffers into a `MediaStream`
4. Create two `RTCPeerConnection` instances: `localPeer` and `remotePeer`
5. Wire ICE candidates: `localPeer.onicecandidate` → `remotePeer.addIceCandidate()` and vice versa
6. Add the MediaStreamDestination's stream track to `localPeer`
7. Do SDP exchange:
   - `localPeer.createOffer()` → `localPeer.setLocalDescription(offer)`
   - `remotePeer.setRemoteDescription(offer)` → `remotePeer.createAnswer()`
   - `remotePeer.setLocalDescription(answer)` → `localPeer.setRemoteDescription(answer)`
8. `remotePeer.ontrack`: create `<audio>` element, set `srcObject` to the received stream, `autoplay = true`
9. Return `true` on success

### `enqueue(samples: Float32Array)`

Same scheduling logic as current implementation:
1. Create `AudioBuffer` from samples
2. Create `AudioBufferSourceNode`, connect to the `MediaStreamDestination` node (instead of `audioContext.destination`)
3. Schedule with `source.start(startTime)`, advance `nextStartTime`
4. Track `source.onended` for state change

The only difference from current code: source connects to `MediaStreamDestination` instead of `audioContext.destination`.

### `clear()`

1. Suspend the AudioContext (stops all scheduled sources immediately)
2. Close and recreate the AudioContext
3. Recreate the `MediaStreamDestination` node
4. Replace the track on `localPeer` with the new destination's track
5. Reset `nextStartTime = 0`
6. Notify state `false`

Note: Peer connections are NOT torn down on clear — they're reused. Only the AudioContext + destination are recycled.

### `destroy()`

1. Close both peer connections
2. Close AudioContext
3. Remove `<audio>` element from DOM
4. Null all references

### `onStateChange(handler)`

Unchanged — same callback pattern.

## What Doesn't Change

- `AudioPlaybackAdapter` interface — identical contract
- `AudioCaptureAdapter` / `web-audio-capture.ts` — unchanged
- `shared/web-sdk/` — no changes
- Pipeline, TurnController, ContinuousSession — no changes
- Echo cooldown (1500ms) and confidence gate (0.9) — kept as defense-in-depth

## Browser Requirements

Minimum: any browser with `RTCPeerConnection` support.
- Chrome 56+ (2017)
- Firefox 44+ (2016)
- Safari 11+ (2017)
- Edge 79+ (2020)

Hard check in `init()` — throw with clear error message if unsupported.

## Testing

Manual verification:
1. Start voice mode, say "Hello" — assistant responds without cutting itself off
2. While assistant speaks, say something — barge-in should work without delay
3. No phantom "Okay" or self-interruption from TTS echo
4. Audio quality should be identical to current playback

## Risks

- WebRTC SDP exchange adds ~50-100ms to `init()` — acceptable, happens once
- Some browsers may handle loopback ICE differently — test Chrome, Firefox, Safari
- Audio latency through the loopback is typically <10ms — imperceptible
