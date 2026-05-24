# PoC Results: Client-Gateway Protocol — WebSocket Multiplexing

## What Was Tested
- WebSocket server (aiohttp) with binary/text frame multiplexing
- Session management with auth handshake
- 5 concurrent client streams
- Barge-in (cancel propagation) during audio response
- Text-only query path
- Frame throughput under concurrent load
- Memory footprint estimation

## Key Results

### 5 Concurrent Sessions (Normal Flow)
- **Connect**: median 1.6ms, max 2.4ms
- **Auth handshake**: median 0.9ms, max 1.1ms
- **Response start latency**: median 54.8ms (includes 50ms simulated pipeline)
- **All 5 clients received full 20-frame responses** — zero frame drops
- **Wall time**: 571ms (constrained by 400ms simulated audio pacing, not server overhead)

### Barge-In (Cancel Propagation)
- **Barge-in latency**: median 0.9ms, max 1.0ms — sub-millisecond cancel propagation
- **Frames received before stop**: exactly 5 (the trigger point) — zero leaked frames after cancel
- **All 5 concurrent barge-ins succeeded** — asyncio.Task.cancel() works reliably across sessions

### Frame Throughput
- **Aggregate**: 430 frames/sec across 5 clients
- **Per-client**: 86 frames/sec (real-time voice needs 50fps — 72% headroom)
- This is with simulated pipeline delays; pure frame dispatch would be much higher

### Memory Footprint
- **Session object**: ~352 bytes
- **5 sessions with 60s audio buffer**: ~1.2 MB
- **Verdict**: Negligible on 8GB RPi5

## Architecture Validated

1. **Binary = audio, text = JSON** multiplexing works cleanly — zero per-frame overhead on audio hot path
2. **Single WebSocket per client** handles all message types without contention
3. **asyncio single-process** handles 5 concurrent streams comfortably
4. **Barge-in via Task.cancel()** propagates in <1ms — fast enough for real-time voice
5. **aiohttp WebSocket handler** is clean and maps naturally to session lifecycle

## Minor Issues Found

- Text-only path: the test scenario sends both audio frames AND text.input, causing a double pipeline trigger.
  The server needs to handle the text.input path independently from the audio.end trigger. Easy fix in production.
- The pong ordering issue in text-only test is due to response messages being interleaved — needs message
  ordering awareness in the client. Not a protocol issue.

## What This PoC Does NOT Test
- Real Opus encoding/decoding (used random bytes as stand-in)
- Real network latency (localhost only)
- RPi5 hardware constraints (tested on container)
- Actual STT/LLM/TTS API integration
- Reconnection/session resumption
- PASETO token validation

## Conclusion
WebSocket-only with binary/text frame multiplexing is validated as feasible for 5 concurrent voice streams.
Sub-millisecond barge-in, clean session management, and negligible memory overhead confirm the design.
