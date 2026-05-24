# Client-Gateway Protocol

## Decision Area
How thin clients (desktop, web, mobile) communicate with the voice gateway on the local network.

## Key Questions
1. **Transport**: REST for text, WebSocket for audio streaming, or unified WebSocket for both?
2. **Audio codec**: Opus (recommended by prior research) — encoding/decoding overhead on RPi5
3. **Message framing**: How audio chunks, text messages, control signals (barge-in, cancel), and auth share the wire
4. **Auth handshake**: Token-based, device cert, PIN, or combination — happens at connection time
5. **Client diversity**: Desktop/web/mobile all need to connect — what's the lowest-common-denominator?
6. **Reconnection**: Session resumption after network drops without losing conversation context

---

## Context: What the Protocol Must Support

The pipeline architecture (decided: single-process asyncio hybrid) defines the protocol's requirements:

1. **Audio upstream**: Client sends Opus-encoded audio chunks (20ms frames, ~40-80 bytes each at 16kbps VoIP) continuously during speech
2. **Audio downstream**: Gateway streams back TTS audio chunks as they're synthesized (streaming overlap — first sentence arrives before LLM finishes)
3. **Text upstream**: Client may send text queries instead of audio (desktop/web convenience)
4. **Text downstream**: Gateway may send transcription text, status updates, tool confirmations
5. **Control signals**: Barge-in (user interrupts assistant), cancel, session start/end, heartbeat
6. **Auth**: Must happen before any audio/text processing — maps connection to a user identity
7. **Confirmation flow**: Tool impact tiers require the gateway to ask "confirm?" and wait for user response

These requirements are inherently **bidirectional and streaming** — the client sends audio while simultaneously receiving audio, and either side may initiate control messages at any time.

---

## Audio Codec: Opus

### Why Opus is the Clear Choice

Opus is the only codec that simultaneously satisfies all constraints:

| Property | Value | Why It Matters |
|----------|-------|---------------|
| Bitrate (voice) | 12-20 kbps | LAN bandwidth is abundant, but low bitrate = small frames = less buffer memory |
| Frame size | 20ms (standard) | Matches Deepgram's expected input; natural chunk boundary |
| Latency | 2.5-60ms algorithmic | SILK mode at 20ms frames = 20ms codec latency |
| CPU (encode) | <1ms per 20ms frame | Negligible on Cortex-A76; GIL released in C extension |
| CPU (decode) | <0.5ms per 20ms frame | Even lighter than encode |
| Browser support | Universal | All modern browsers via MediaRecorder/WebAudio API; WebAssembly polyfill via opus-media-recorder |
| Mobile support | Native | iOS AVAudioEngine + Opus; Android MediaCodec + Opus natively since API 29 |
| Python support | `opuslib` (ctypes) or `pyogg` | Wraps libopus; async-compatible via `run_in_executor` |

### 5 Concurrent Streams: CPU Impact on RPi5

Per-stream: encode + decode = ~1.5ms per 20ms frame = 7.5% of one core per stream.
5 streams: ~37.5% of one core. With 4 cores available and the ThreadPoolExecutor already planned, this is trivially handled. Audio codec is confirmed as a non-bottleneck.

### Frame Format

Opus frames are self-delimiting when you know the frame size. The protocol must transmit:
- Raw Opus bytes (the payload)
- Sample rate (48000 Hz standard, can negotiate down to 16000 for voice-only)
- Channels (1 = mono for voice)

These parameters are negotiated once at session start, so each audio frame is just raw Opus bytes with no per-frame header needed within WebSocket binary messages.

---

## Message Framing Design

Regardless of transport choice, the protocol needs a clear framing scheme for multiplexing audio, text, and control on the same connection.

### Proposed Frame Protocol

**Binary frames** = audio data (raw Opus bytes). No header needed — binary frames are always audio.

**Text frames** = JSON messages with a `type` field:

```json
// Client → Gateway
{"type": "session.start", "token": "PASETO_TOKEN_HERE", "audio_config": {"codec": "opus", "sample_rate": 48000, "channels": 1}}
{"type": "audio.start"}           // User started speaking
{"type": "audio.end"}             // User stopped speaking (VAD from client)
{"type": "text.input", "text": "What's the weather?"} // Text-only query
{"type": "barge_in"}              // User interrupted assistant
{"type": "tool.confirm", "tool_call_id": "abc123", "approved": true}
{"type": "ping"}                  // Keepalive

// Gateway → Client
{"type": "session.ready", "session_id": "uuid", "user": "kevin"}
{"type": "transcript", "text": "What's the weather?", "is_final": true}
{"type": "response.start"}       // LLM response beginning
{"type": "response.text", "text": "The weather today is..."} // Streaming text (optional display)
{"type": "audio.start"}          // TTS audio about to stream
{"type": "audio.end"}            // TTS audio finished
{"type": "tool.confirm_request", "tool_call_id": "abc123", "tool": "send_message", "description": "Send SMS to Mom: 'Running late'"}
{"type": "response.end"}         // Full response complete
{"type": "error", "code": "auth_failed", "message": "Invalid token"}
{"type": "pong"}
```

**Key design choices:**
- Binary frames are *always* audio — no type header needed, which saves bandwidth on the hot path (50 audio frames/second at 20ms)
- Text frames carry JSON — human-readable, debuggable, extensible (add fields without breaking old clients)
- Minimal message types — each maps directly to a pipeline event or frame type
- `audio.start`/`audio.end` bracket audio streaming in both directions, providing clear turn-taking signals
- Tool confirmation is a first-class message type, not a hack

This framing works identically for WebSocket and for any transport that distinguishes binary vs text frames.

---

## Approaches Evaluated

### A. WebSocket-Only (Unified)

Single WebSocket connection per client session carries everything: auth, audio, text, control.

**Architecture:**
```
Client                                Gateway
  |                                      |
  |──── WS Connect (/ws) ──────────────>|
  |──── {"type":"session.start",...} ──>|  Auth + session setup
  |<─── {"type":"session.ready",...} ───|
  |                                      |
  |──── {"type":"audio.start"} ────────>|  User speaks
  |──── [binary: opus frame] ─────────>|
  |──── [binary: opus frame] ─────────>|
  |──── {"type":"audio.end"} ─────────>|
  |                                      |  STT → Classifier → LLM → TTS
  |<─── {"type":"response.start"} ─────|
  |<─── {"type":"audio.start"} ────────|  TTS audio streaming
  |<─── [binary: opus frame] ──────────|
  |<─── [binary: opus frame] ──────────|
  |──── {"type":"barge_in"} ──────────>|  User interrupts!
  |<─── {"type":"audio.end"} ──────────|  Gateway stops TTS
  |                                      |
  |──── {"type":"text.input",...} ─────>|  Text-only query
  |<─── {"type":"response.text",...} ───|  Streaming text response
```

**Server implementation (Python asyncio):**

Using `aiohttp` (already needed for HTTP routes like health checks):

```python
async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    session = None
    async for msg in ws:
        if msg.type == WSMsgType.TEXT:
            data = json.loads(msg.data)
            if data["type"] == "session.start":
                session = await authenticate_and_create(data, ws)
            elif data["type"] == "audio.start":
                session.pipeline.start_listening()
            elif data["type"] == "barge_in":
                await session.pipeline.interrupt()
            # ... etc
        elif msg.type == WSMsgType.BINARY:
            # Audio frame — push directly into pipeline
            await session.pipeline.push_audio(msg.data)
```

**Client implementation complexity:**

| Platform | WebSocket Support | Notes |
|----------|------------------|-------|
| Web (JS) | Native `WebSocket` API | Binary + text frames natively supported |
| Desktop (Python/Electron) | `websockets` / native | Trivial |
| iOS | `URLSessionWebSocketTask` (iOS 13+) | Native; handles binary/text frames |
| Android | OkHttp WebSocket | Native; handles binary/text frames |

**Pros:**
- **Single connection** — simplest mental model, one thing to manage per client
- **True bidirectional streaming** — audio flows both ways simultaneously; barge-in is instant
- **Low overhead** — WebSocket frames have 2-14 byte headers vs HTTP's ~200-500 byte headers per request
- **Natural fit** — the protocol IS inherently bidirectional streaming; WebSocket was designed for this
- **Server simplicity** — one handler, one connection per client, maps cleanly to one pipeline per session
- **Aligns with industry** — Home Assistant, Deepgram, Fish Audio all use WebSocket for real-time voice
- **Aligns with pipeline architecture** — WebSocket messages map 1:1 to pipeline frames

**Cons:**
- **Debugging** — binary audio frames aren't human-readable in browser DevTools (but JSON control messages are)
- **No caching** — WebSocket responses aren't cacheable (irrelevant for real-time voice)
- **Proxy/firewall traversal** — some corporate proxies block WebSocket (irrelevant for LAN)
- **Reconnection logic** — must be implemented explicitly (see Reconnection section below)
- **Load balancer complexity** — sticky sessions needed (irrelevant — no load balancer on single RPi5)

**Risk assessment:** The cons are either irrelevant (LAN deployment, no load balancer) or manageable (reconnection is well-understood). WebSocket is the industry standard for real-time voice — fighting it would be contrarian without benefit.

---

### B. Hybrid REST + WebSocket

REST endpoints for text queries, session management, and auth. WebSocket exclusively for audio streaming.

**Architecture:**
```
Client                                Gateway
  |                                      |
  |──── POST /auth {credentials} ─────>|  Get session token
  |<─── {"session_id":"uuid","token":..}|
  |                                      |
  |──── POST /query {text, token} ────>|  Text-only query
  |<─── SSE: {"text":"The weather..."} ─|  Streaming text response
  |                                      |
  |──── WS Connect (/audio?token=...) ─>|  Audio session
  |──── [binary: opus frame] ─────────>|
  |<─── [binary: opus frame] ──────────|
  |──── {"type":"barge_in"} ──────────>|
  |                                      |
  |──── GET /session/{id}/status ─────>|  Check session state
  |<─── {"active": true, "user":...} ──|
```

**Pros:**
- **REST is familiar** — text queries via `curl`, Postman, or any HTTP client
- **Easy debugging** — REST requests/responses are fully visible in standard tools
- **Separation of concerns** — text path is stateless, audio path is stateful
- **Cacheable text** — (irrelevant for voice assistant, but REST allows it)
- **Incremental development** — can build and test text path before audio path

**Cons:**
- **Two connection models** — client must implement both REST and WebSocket; server must handle both
- **Session coordination** — REST and WebSocket must share session state; token passed in both paths
- **Barge-in is awkward** — if the user sends a text query via REST while audio is playing via WebSocket, how does the cancel propagate? Requires cross-connection signaling.
- **SSE is half-duplex** — REST + SSE gives you server streaming but not client streaming; client can't send audio chunks via SSE
- **Tool confirmation is split** — if the original request was text (REST), the confirmation prompt goes via... REST? WebSocket? Both?
- **Double the API surface** — more code, more tests, more documentation, more client-side logic
- **Doesn't match the pipeline** — the pipeline is a single bidirectional stream; splitting into REST + WebSocket means an adapter layer to unify them before the pipeline

**Risk assessment:** The added complexity isn't justified by any concrete benefit. REST's advantages (debuggability, caching, statelessness) don't apply to a real-time voice assistant where every interaction is stateful and streaming. The split creates coordination problems (barge-in across connections, session sharing) that WebSocket-only avoids entirely.

---

### C. REST-Only with Chunked Transfer / SSE

All communication via HTTP. Chunked transfer encoding for uploading audio, Server-Sent Events for streaming responses.

**Architecture:**
```
Client                                Gateway
  |                                      |
  |──── POST /auth {credentials} ─────>|
  |<─── {"token": "..."} ──────────────|
  |                                      |
  |──── POST /speech                    |  Chunked upload: audio
  |     Transfer-Encoding: chunked      |
  |     [opus chunk]                    |
  |     [opus chunk]                    |
  |     [opus chunk]                    |
  |<─── SSE: audio chunk (base64)       |  Response streamed back
  |<─── SSE: audio chunk (base64)       |
  |<─── SSE: done                       |
```

**Pros:**
- **Universal compatibility** — every HTTP client supports this
- **Simplest client** — `fetch()` with a ReadableStream; no WebSocket library needed
- **Debuggable** — all traffic visible in browser DevTools as HTTP

**Cons:**
- **No true bidirectional streaming** — HTTP is request-response; chunked transfer encoding is a hack for streaming upload, and SSE is server-to-client only
- **Audio in SSE requires base64** — SSE is text-only, so binary audio must be base64-encoded (33% overhead) or a separate binary endpoint is needed
- **Barge-in is fundamentally broken** — how does the client signal "stop" while its POST is still uploading? A separate POST `/cancel`? Race conditions abound
- **Latency penalty** — each new utterance is a new HTTP request (TCP handshake, TLS, headers) vs WebSocket's persistent connection
- **Half-duplex** — can't send audio and receive audio simultaneously on one HTTP connection; need two connections minimum
- **SSE connection limits** — browsers limit SSE connections per domain (6 in some browsers), and each SSE requires a persistent HTTP connection
- **Tool confirmation breaks the model** — the gateway needs to ask a question mid-response and wait for an answer; HTTP request-response can't do this without polling or a separate channel

**Risk assessment:** REST-only fundamentally cannot support the bidirectional, real-time nature of voice interaction. Barge-in (a core requirement) is impossible without introducing WebSocket-like complexity through polling or secondary connections, at which point you've rebuilt WebSocket poorly. This approach is a non-starter for the audio path.

---

## Cross-Cutting Concerns

### Auth Handshake

Auth must happen before any data flows. In WebSocket-only (Approach A), the first message after connection is `session.start` with a PASETO token:

```
1. Client connects to ws://gateway:8765/ws
2. Client sends: {"type": "session.start", "token": "v4.local.xxx"}
3. Gateway validates token, loads user profile + memory
4. Gateway sends: {"type": "session.ready", "session_id": "uuid", "user": "kevin"}
5. Client is now authorized for audio/text
```

**Why not auth in the URL or HTTP headers?**
- URL params (`?token=xxx`) are logged in server access logs — security risk
- HTTP headers work for the upgrade request, but then the token isn't in the WebSocket message flow — harder to correlate
- First-message auth keeps the entire auth flow within the WebSocket protocol, making it auditable and consistent

**Timeout:** If `session.start` isn't received within 5 seconds of connection, the gateway closes the socket with code 4001 (auth timeout).

### Reconnection & Session Resumption

Network drops are expected on WiFi (LAN) and especially on mobile. The protocol must handle:

1. **Connection drops mid-conversation** — gateway has conversation history; client reconnects
2. **Connection drops mid-response** — TTS audio partially delivered; client reconnects

**Strategy (inspired by WebSocket.org best practices):**

```
1. Gateway assigns session_id on session.ready
2. Client stores session_id locally
3. On disconnect: client reconnects with exponential backoff (500ms → 1s → 2s → 4s, max 30s, with jitter)
4. Client sends: {"type": "session.resume", "token": "v4.local.xxx", "session_id": "old-uuid"}
5. Gateway checks:
   a. Token valid? → Yes
   b. Session exists and belongs to this user? → Yes
   c. Session age < 5 minutes? → Yes
   → Gateway sends: {"type": "session.resumed", "session_id": "old-uuid"}
   → Conversation history is preserved
6. If session expired or not found:
   → Gateway sends: {"type": "session.new", "session_id": "new-uuid"}
   → Fresh session, but per-user memory is still loaded from disk
```

**Key design choice:** Conversation history lives server-side (in the session object in memory). The client doesn't need to replay anything on reconnect — it just gets a new WebSocket connection attached to the same session. Any in-flight response is lost (client can request a re-generation if needed), but the conversation context is preserved.

**Session TTL:** 5 minutes of inactivity or disconnection. After that, the session is garbage collected. Memory files on disk survive indefinitely.

### Heartbeat / Keepalive

WebSocket connections can silently die (NAT timeout, WiFi roaming). Detect dead connections:

```
- Client sends {"type": "ping"} every 30 seconds
- Gateway responds {"type": "pong"}
- If gateway doesn't receive a ping for 60 seconds → close connection, keep session alive for 5 minutes
- If client doesn't receive pong within 5 seconds → consider connection dead, trigger reconnection
```

This is application-level heartbeat on top of WebSocket's protocol-level ping/pong (which isn't accessible in browser JS).

### Client Diversity

All three platforms must implement:
1. WebSocket connection management (connect, reconnect, heartbeat)
2. Opus encoding (microphone → Opus frames) and decoding (Opus frames → speaker)
3. JSON message serialization/deserialization
4. Audio capture (microphone access) and playback

| Platform | WebSocket | Opus Encode | Opus Decode | Audio I/O |
|----------|-----------|-------------|-------------|-----------|
| Web | Native `WebSocket` | `MediaRecorder` with Opus or WebAssembly `libopus` | `AudioContext.decodeAudioData()` or WebAssembly | `getUserMedia()` / `AudioContext` |
| Desktop (Python) | `websockets` | `opuslib` | `opuslib` | `sounddevice` or `pyaudio` |
| Desktop (Electron) | Native `WebSocket` | Same as Web | Same as Web | Same as Web |
| iOS | `URLSessionWebSocketTask` | `AVAudioEngine` + `libopus` | `AVAudioEngine` + `libopus` | `AVAudioSession` |
| Android | OkHttp | `MediaCodec` (native Opus API 29+) | `MediaCodec` | `AudioRecord`/`AudioTrack` |

**Lowest common denominator:** WebSocket + Opus + JSON. All platforms support all three natively or via well-maintained libraries. No platform-specific protocol adaptations needed.

---

## Analysis & Recommendation

### Decision Matrix

| Factor | A. WebSocket-Only | B. Hybrid REST+WS | C. REST-Only |
|--------|:-:|:-:|:-:|
| Bidirectional streaming | Native | Split | Impossible |
| Barge-in support | Natural (send frame) | Cross-connection | Broken |
| Implementation complexity (server) | Low | Medium-High | Medium |
| Implementation complexity (client) | Low | Medium | Low-Medium |
| Debugging | Medium (JSON readable, binary not) | High (REST part) | High |
| Connection count per client | 1 | 2+ | 2+ |
| Alignment with pipeline | Excellent | Poor (adapter needed) | Poor |
| Industry precedent | Strong (HA, Deepgram, Fish Audio) | Some | None for voice |
| Tool confirmation flow | Natural (async message) | Awkward (cross-channel) | Broken (polling) |
| Mobile reliability | Good (native WS support) | Complex (two channels) | Good |

### Recommendation: Approach A (WebSocket-Only)

**WebSocket-only is the clear winner.** The voice gateway protocol is inherently bidirectional and streaming — WebSocket is the transport designed for exactly this. The alternatives either add complexity without benefit (hybrid) or fundamentally can't support the requirements (REST-only).

**Why not B (Hybrid)?** The only advantage is REST debuggability for text-only queries. But text-only queries are a minority use case (this is a *voice* gateway), and they work fine over WebSocket. The cost — doubled API surface, cross-connection session coordination, awkward barge-in — far outweighs the benefit of `curl`-able text queries.

**Why not C (REST-only)?** Barge-in is a core requirement. REST cannot support it. Full stop.

### Key Architecture Decisions

1. **Transport**: Single WebSocket connection per client session — carries audio, text, and control
2. **Audio codec**: Opus at 16-20kbps, 20ms frames, mono — universal client support, negligible CPU on RPi5
3. **Frame multiplexing**: Binary frames = audio, text frames = JSON messages — zero-overhead audio path, debuggable control path
4. **Auth**: First-message PASETO token within WebSocket; 5-second timeout to auth or disconnect
5. **Reconnection**: Session ID + exponential backoff with jitter; server-side session survives 5 minutes; conversation history preserved
6. **Heartbeat**: Application-level ping/pong every 30 seconds (browser JS can't access WebSocket-level ping)
7. **Server library**: `aiohttp` — provides both WebSocket handler and HTTP routes (health check, metrics) in one server
8. **Message protocol**: Minimal JSON message types mapping 1:1 to pipeline frame types

### Integration with Pipeline Architecture

The WebSocket handler becomes the "Transport" processor in the pipeline:

```
[WebSocket Handler] ←→ [TransportProcessor] ←→ [Pipeline]
```

- Incoming binary frame → `AudioEncodedFrame` pushed downstream
- Incoming JSON `barge_in` → `InterruptionFrame` (SystemFrame) pushed downstream
- Outgoing `AudioEncodedFrame` → binary frame sent to client
- Outgoing JSON status → text frame sent to client

The TransportProcessor is the bridge between the wire protocol and the frame-based pipeline. It holds a reference to the WebSocket connection and translates between the two worlds.

### Open Questions for Scoring

- Should the gateway support multiple WebSocket connections per user (e.g., phone and laptop simultaneously)?
- What is the optimal Opus bitrate for voice quality vs bandwidth on LAN? (16kbps is safe, but 24kbps may be worth it)
- Should the protocol version be negotiated at session start for future-proofing?
- How should audio format negotiation work if we ever support codecs beyond Opus?

---

## Score — Round 1
- Feasibility & Validation: 5/10
- Maintainability & Testability: 5/10
- Risk & Trade-offs: 6/10
- Effort & Complexity: 8/10
- Alignment: 9/10
- **Total: 33/50**

### Friction Log
- **Feasibility**: No PoC exists — Opus encoding, WebSocket frame multiplexing, barge-in delivery, and 5-stream CPU load are all unvalidated. GIL + Python dispatch overhead at 50fps × 5 streams is plausible but unmeasured.
- **Maintainability**: No test strategy. The handler is a flat dispatch loop that will bloat as message types grow. No handler registry, message validator, or schema.
- **Risk**: Multi-device-per-user (phone + laptop) is undefined — session model would collide. Session memory footprint and zombie session accumulation unaddressed. PASETO token lifecycle (issuance, refresh, revocation) not covered. In-flight tool confirmation on disconnect is undefined.

### What's Strong
- WebSocket-only vs hybrid vs REST analysis is thorough and honest
- Binary-frames-are-always-audio framing is elegant (zero overhead on 50fps hot path)
- Reconnection strategy is well-specified
- Client diversity matrix is practical, not hand-waving
- Pipeline integration (TransportProcessor bridge) is clean

### Expansion Actions
- PoC needed to validate Opus + WebSocket multiplexing + barge-in under concurrency
- Decompose into sub-decisions: message dispatch architecture, multi-device handling, session lifecycle, protocol versioning
