# WebRTC Loopback Playback

The webui routes TTS audio through a local RTCPeerConnection loopback so
the browser's built-in AEC treats the output as "remote audio" and
subtracts it from the mic. Enables true barge-in without any pipeline
changes on the gateway side.

## Signal chain

```
AudioContext → GainNode → MediaStreamDestination
  → localPeer (sender) → [loopback SDP] → remotePeer (receiver)
  → <audio> element → speakers → browser AEC subtracts from mic
```

The `<audio>` element is never appended to the DOM. It exists in memory
holding the MediaStream. `document.querySelectorAll('audio')` will not
find it.

## Jitter-buffer pitfall on `clear()`

The receiver keeps a 200-500ms jitter buffer. Early implementations of
`clear()` kept the peer alive and merely called `replaceTrack()` +
`reattachAudio()` — this re-wakes the `<audio>` element, which replays
the buffered frames. User hears ~500ms of the interrupted reply continue
after clicking Stop.

**Fix** (commit `de44a97`): `clear()` does a full `peer.destroy()` then
`peer.setup()` async. The receiver track is stopped (buffered frames
discarded); a fresh peer comes up for the next cycle. Verified in Chrome
DevTools: `playback.stop` → `peer destroy` → `peer.setup` completes
before next cycle's first audio arrives.

## Generation counter

`clear()` increments a `generation` counter. Every `AudioBufferSourceNode`
captures its generation in its `onended` closure. After clear, stale
`onended` callbacks see `g !== generation` and early-return, so they
can't decrement `pendingSourceCount` below zero or spuriously fire
`onDrain`.

## Implementation

- `gateway/webui/src/adapters/web-audio-playback.ts` — AudioContext + GainNode + generation counter
- `gateway/webui/src/adapters/web-audio-playback-peer.ts` — peer lifecycle (setup, destroy, track replacement)
- `gateway/webui/src/adapters/web-audio-playback.test.ts` — drain + fade + generation-counter tests

## Why loopback, not `audioContext.destination`?

Going through WebRTC is the cheapest way to get AEC on browser-produced
audio. Direct playback (`audioContext.destination`) bypasses AEC entirely;
the mic would pick up the TTS and trigger false barge-ins.
