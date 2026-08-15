# WebRTC loopback playback

WebRTC loopback is an optional browser playback enhancement. When available, the adapter routes Web Audio output through a local `RTCPeerConnection` pair so browser echo cancellation can classify it as remote audio. Capture remains usable without this path; `getUserMedia` uses the browser's own `echoCancellation` constraint and the UI must retain text-only fallback.

```text
AudioContext → MediaStreamDestination → local peer
  → local SDP loopback → remote peer → in-memory <audio> → speakers
```

The audio element is created in memory and is not appended to the document. `createAudioLoopbackPeer()` owns setup, track replacement, and teardown. Playback `clear()` destroys the peer and asynchronously recreates it so receiver jitter-buffered audio cannot leak after Interrupt or barge-in. A generation counter in the playback adapter makes stale source `onended` callbacks harmless.

The loopback is not authorization, turn state, or the audio queue. It must not block capture startup or text messaging. Browser autoplay, permissions, and platform AEC differences remain valid operator/browser follow-up cases.

Relevant code:

- `gateway/webui/src/adapters/web-audio-playback-peer.ts`
- `gateway/webui/src/adapters/web-audio-playback.ts`
- `gateway/webui/src/adapters/web-audio-capture.ts`

Test the adapter's drain, clear, and stale-generation behavior at its public interface; do not depend on a particular browser's jitter timing.
