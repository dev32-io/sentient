# Client-Gateway Protocol

## Decision Area
WebSocket-based protocol for audio streaming and control messages between clients (Android, iOS, Web) and the voice gateway.

## Key Questions
- Message framing: binary frames for audio, text frames for JSON control?
- Auth handshake: PASETO token as first message, 5-second timeout?
- Guest onboarding: QR code? PIN? Host approval? Link with embedded token?
- Message types catalog: session.start, audio.start/end, text.input, barge_in, tool.confirm, transcript, response.text, response.audio, error, etc.?
- Reconnection: session ID + exponential backoff with jitter?
- Server-side session persistence: how long does a session survive disconnect?
- Audio codec: Opus (compressed) vs raw PCM (simpler passthrough)?
- Barge-in protocol: client sends barge_in → gateway cancels pipeline → confirms?
- Cellular handoff: WiFi↔cellular reconnection without losing session?
- Heartbeat/keepalive: WebSocket ping/pong or application-level?

## Prior Research
- Python iteration concluded WebSocket-only with Opus
- Message type catalog drafted in prior research
- Gateway-core PoC validated WebSocket binary relay performance (272K frames/sec Bun, 121K Node)
- Android/iOS explorations detailed codec options, reconnection, and barge-in client-side
- Security exploration defined PASETO v4.local auth, guest token flow, role matrix
- Wake-word exploration defined pre-trigger audio transmission protocol

## Approaches

### Approach A: WebSocket-Only, Opus Audio

**Description:** Single WebSocket connection per client session carrying both binary Opus audio frames and JSON text control messages. Opus encoding/decoding happens on clients and at provider boundaries — the gateway passes through binary frames without touching codec.

**Architecture:**
```
Client                          Gateway                        STT/TTS Provider
  |                                |                                |
  |--[text] auth {token}---------->|  verify PASETO                 |
  |<-[text] auth.ok {session_id}---|                                |
  |                                |                                |
  |--[text] session.start--------->|  create pipeline               |
  |--[binary] Opus pre-trigger---->|--[relay/transcode]------------>|
  |--[binary] Opus live frames---->|--[relay/transcode]------------>|
  |                                |<-[transcript partials]---------|
  |<-[text] transcript.partial-----|                                |
  |<-[text] transcript.final-------|                                |
  |                                |  classifier → LLM/tools        |
  |<-[text] response.text.partial--|                                |
  |<-[binary] Opus TTS chunks-----|<-[TTS audio]-------------------|
  |                                |                                |
  |--[text] barge_in-------------->|  cancel pipeline               |
  |<-[text] barge_in.ack----------|                                |
```

**Frame Design:**
- **Binary frames:** Raw Opus packets. 20ms frames at 16kHz = 320 samples/frame. At 24kbps Opus, each frame is ~60 bytes. ~50 frames/sec per session.
- **Text frames:** JSON control messages. All have `{ type: string, ...payload }` structure. Average size: 100-500 bytes.
- **No multiplexing header needed:** WebSocket already distinguishes binary vs text frames. One binary stream direction at a time (either client→gateway mic audio OR gateway→client TTS audio).
- **Max frame size:** 64KB (Opus frames are tiny; JSON control messages well under this)

**Codec Details:**
- Client encodes: PCM from mic → Opus 24kbps, 20ms frames, mono, 16kHz
- Gateway relays binary frames to STT provider (may need Opus→PCM transcode if STT wants PCM)
- TTS provider returns audio (format varies) → gateway may transcode to Opus → relay to client
- Gateway codec work is at provider boundaries only, not per-frame processing
- Bandwidth: ~24kbps up + ~24kbps down = ~48kbps total (vs 512kbps for raw PCM both ways)

**Pros:**
- **10x bandwidth reduction** — 24kbps Opus vs 256kbps raw PCM per direction
- **Single connection** — simpler connection management, auth, reconnection
- **Proven pattern** — Discord, Slack Huddles, LiveKit all use WebSocket + Opus
- **Cellular friendly** — 48kbps total works on poor 3G connections
- **Gateway stays thin** — binary passthrough, no per-frame processing on hot path
- **Built-in frame typing** — WebSocket binary/text opcode eliminates need for custom framing

**Cons:**
- **Opus codec complexity** — each platform needs Opus encode/decode: Android (Concentus or libopus JNI), iOS (libopus C interop), Web (WebCodecs API or WASM)
- **Provider transcoding** — Deepgram accepts Opus natively (encoding=opus), but some STT providers want PCM. Gateway needs conditional transcode at STT boundary.
- **Debugging harder** — can't read binary Opus frames in browser devtools. Need hex dump tooling.
- **Client-side battery** — Opus encoding uses more CPU than raw PCM passthrough (but marginal at voice bitrates)

### Approach B: WebSocket-Only, Raw PCM Audio

**Description:** Same single-connection architecture, but audio frames are raw 16-bit PCM at 16kHz mono. No client-side codec. Gateway passes raw PCM to STT (which all accept PCM natively).

**Frame Design:**
- **Binary frames:** Raw PCM 16-bit signed LE, 16kHz mono. 20ms chunks = 640 bytes per frame. ~50 frames/sec per session.
- **Text frames:** Same JSON control messages as Approach A.

**Pros:**
- **Zero codec complexity** — no Opus library on any platform. Android AudioRecord outputs PCM. iOS AVAudioEngine outputs PCM. Web MediaStream outputs PCM (via AudioWorklet).
- **All STT providers accept PCM** — no transcoding at gateway. Direct passthrough.
- **Easier debugging** — PCM frames can be dumped to .wav for inspection
- **Faster prototype** — skip codec integration, get end-to-end working faster
- **Lower client CPU** — no encoding overhead (marginal savings but real on older phones)

**Cons:**
- **10x more bandwidth** — 256kbps per direction (512kbps total) vs 48kbps with Opus
- **WiFi-only viable** — 512kbps is fine on LAN but poor on cellular/Tailscale remote access
- **Larger pre-trigger buffer transfer** — 2 seconds of PCM = 64KB vs ~6KB with Opus
- **No packet loss resilience** — Opus has built-in FEC; raw PCM corrupts on any loss
- **TTS return path still needs audio** — if TTS returns Opus/MP3, gateway must decode to PCM for client, adding server-side codec work

### Approach C: WebSocket + Separate Audio Channel

**Description:** Two WebSocket connections per client: one for JSON control messages, one for binary audio streaming. Audio channel is established after control channel auth succeeds.

**Architecture:**
```
Client                          Gateway
  |--[WS1/text] auth {token}----->|  verify PASETO
  |<-[WS1/text] auth.ok-----------|
  |--[WS2] audio channel open---->|  link to session via session_id
  |--[WS2/binary] audio frames--->|
  |<-[WS2/binary] TTS audio-------|
  |<-[WS1/text] transcript--------|
  |<-[WS1/text] response.text-----|
```

**Pros:**
- **Clean separation** — audio and control on different channels, no interleaving
- **Independent flow control** — audio backpressure doesn't block control messages
- **Easier audio-only reconnect** — can re-establish audio channel without losing control state
- **Parallel processing** — audio frames don't queue behind large JSON messages

**Cons:**
- **Double connections** — 20 WebSocket connections for 10 sessions instead of 10. More file descriptors, more TLS handshakes.
- **Sync complexity** — must correlate audio and control channels via session_id. Race conditions on channel setup.
- **Double auth** — or token-based channel linking, adding protocol complexity
- **Marginal benefit** — at 10 sessions with tiny frames, interleaving latency is <1ms. No real backpressure issue.
- **Mobile connection management** — two connections to monitor, reconnect, and coordinate. Doubles reconnection logic.
- **Overkill for scale** — Discord uses dual channels at millions of users. At 10 sessions, single connection is fine.

## Protocol Design (Cross-Approach)

### Message Type Catalog

**Client → Gateway:**
| Type | Frame | Description |
|------|-------|-------------|
| `auth` | text | First message. `{ type: "auth", token: "<PASETO>" }`. 5-second timeout. |
| `session.start` | text | `{ type: "session.start", encoding: "opus"\|"pcm_s16le", sample_rate: 16000, pretrigger_ms?: 2000 }` |
| `audio.start` | text | Client started speaking (after wake word or PTT press) |
| *(binary)* | binary | Audio frames. No JSON wrapper. |
| `audio.end` | text | Client stopped speaking (silence detected or PTT release) |
| `text.input` | text | Text-only input (web chat). `{ type: "text.input", text: "..." }` |
| `barge_in` | text | User interrupted. Gateway must cancel current response pipeline. |
| `tool.confirm` | text | User approved/denied a tool action. `{ type: "tool.confirm", tool_id: "...", approved: bool }` |
| `session.end` | text | Client explicitly ending session |
| `pong` | text | Response to server ping (if app-level heartbeat) |

**Gateway → Client:**
| Type | Frame | Description |
|------|-------|-------------|
| `auth.ok` | text | Auth succeeded. `{ type: "auth.ok", session_id: "...", user: { name, role } }` |
| `auth.error` | text | Auth failed. `{ type: "auth.error", reason: "..." }`. Close connection. |
| `session.ready` | text | Pipeline initialized, ready for audio |
| `transcript.partial` | text | Interim STT result. `{ type: "transcript.partial", text: "...", is_final: false }` |
| `transcript.final` | text | Final STT result. `{ type: "transcript.final", text: "...", confidence: 0.95 }` |
| `response.text.start` | text | LLM response stream starting |
| `response.text.delta` | text | LLM token chunk. `{ type: "response.text.delta", text: "..." }` |
| `response.text.done` | text | LLM response complete |
| *(binary)* | binary | TTS audio frames |
| `response.audio.start` | text | TTS streaming starting |
| `response.audio.done` | text | TTS streaming complete |
| `tool.request` | text | Tool needs user confirmation. `{ type: "tool.request", tool_id, name, description, impact_tier }` |
| `tool.result` | text | Tool execution result for display. `{ type: "tool.result", tool_id, result }` |
| `barge_in.ack` | text | Gateway acknowledged barge-in, pipeline cancelled |
| `error` | text | Error message. `{ type: "error", code: "...", message: "..." }` |
| `ping` | text | App-level heartbeat (if used) |
| `session.expired` | text | Session timed out during disconnect |

### Connection Lifecycle

```
1. CLIENT: WebSocket connect to wss://gateway.local/ws
2. CLIENT → GW: { type: "auth", token: "<PASETO v4.local>" }
   - Gateway has 5-second window to receive auth message
   - If timeout or invalid token → close(4001, "auth_failed")
3. GW → CLIENT: { type: "auth.ok", session_id: "abc123", user: { name: "Kevin", role: "adult" } }
4. CLIENT → GW: { type: "session.start", encoding: "opus", sample_rate: 16000, pretrigger_ms: 2000 }
5. GW → CLIENT: { type: "session.ready" }
6. --- Session active, audio/control flow begins ---
7. CLIENT → GW: { type: "audio.start" }
8. CLIENT → GW: [binary] pre-trigger audio buffer (2 seconds)
9. CLIENT → GW: [binary] live audio frames (20ms each)
10. CLIENT → GW: { type: "audio.end" }
11. GW → CLIENT: { type: "transcript.partial", text: "What's the wea..." }
12. GW → CLIENT: { type: "transcript.final", text: "What's the weather?" }
13. GW → CLIENT: { type: "response.text.start" }
14. GW → CLIENT: { type: "response.text.delta", text: "It's currently" }
15. GW → CLIENT: { type: "response.text.delta", text: " 72°F and sunny" }
16. GW → CLIENT: { type: "response.text.done" }
17. GW → CLIENT: { type: "response.audio.start" }
18. GW → CLIENT: [binary] TTS audio frame 1
19. GW → CLIENT: [binary] TTS audio frame 2...N
20. GW → CLIENT: { type: "response.audio.done" }
21. --- Ready for next utterance ---
```

### Auth Handshake

- **First message must be auth.** No other messages accepted before auth.
- **5-second timeout.** If no auth message within 5s of connection, gateway sends close(4001) and disconnects.
- **PASETO v4.local token** verified server-side. Token contains: `{ sub, role, iat, exp, jti, deviceId? }`.
- **Close codes:**
  - `4001` — auth failed (invalid/expired/missing token)
  - `4002` — session limit reached (10 concurrent)
  - `4003` — session expired (reconnect with stale session_id)
  - `4004` — protocol error (unexpected message type/sequence)
  - `4008` — rate limited
  - `1000` — normal close
  - `1001` — going away (server shutdown)

### Guest Onboarding Flow

Leveraging the security exploration's design:

1. **Adult voice command:** "Hey Aria, create a guest pass"
2. **Gateway generates:** 6-digit PIN + QR code URL (valid 1 hour to claim)
3. **Guest connects:**
   - Web: visits link with embedded PIN, or enters PIN on landing page
   - Mobile: scans QR code → opens app → auto-authenticates
4. **Guest auth:** `POST /auth/guest { pin: "847291" }` → returns PASETO guest token (4-hour TTL)
5. **Guest WebSocket:** connects normally with guest token; role=guest in token claims
6. **Restrictions enforced per message:** guest sessions skip memory writes, block write-tier tools, 4-hour auto-expire

### Reconnection Protocol

**Client-side (exponential backoff with full jitter):**
```
attempt = 0
while not connected:
  delay = min(60000, 1000 * 2^attempt)
  jittered = random(0, delay)
  sleep(jittered)
  try connect with: ?session_id=abc123&last_seq=42
  attempt++
```

**Server-side session persistence:**
- On disconnect: session enters `SUSPENDED` state, timer starts (120 seconds)
- Session state preserved: conversation history, active tool calls, user context
- On reconnect with valid session_id:
  - If within 120s: resume session, replay events after `last_seq`
  - If expired: send `session.expired`, client must start fresh
- On reconnect without session_id: new session (fresh auth)
- Guest sessions: 60-second suspend window (shorter, they're ephemeral)

**Sequence numbers:**
- Every gateway→client text message includes a monotonic `seq` field
- Client tracks last received `seq`
- On reconnect, client sends `last_seq` — gateway replays missed messages
- Binary audio frames are NOT sequenced (real-time, no replay value)
- Server-side replay buffer: last 100 messages per session (text only)

**Network handoff (WiFi↔cellular):**
- Android `ConnectivityManager.NetworkCallback` / iOS `NWPathMonitor` detect transport change
- On transport change: proactively close old WebSocket, reconnect with session_id
- Don't wait for TCP timeout (can take 30-60s) — detect network change immediately

### Barge-In Protocol

```
1. User speaks wake word while TTS is playing
2. CLIENT: immediately stops audio playback
3. CLIENT → GW: { type: "barge_in" }
4. GW: cancels active pipeline (AbortController):
   - Stops LLM generation
   - Stops TTS generation
   - Stops sending audio frames
   - Discards queued audio
5. GW → CLIENT: { type: "barge_in.ack" }
6. CLIENT → GW: { type: "audio.start" }
7. CLIENT → GW: [binary] pre-trigger audio (ring buffer)
8. CLIENT → GW: [binary] live audio frames
9. --- New utterance flows through pipeline ---
```

**Timing:** Gateway barge-in acknowledgment measured at ~100ms in gateway-core PoC (AbortController propagation through pipeline stages).

### Heartbeat / Keepalive

**Approach: WebSocket protocol-level ping/pong (preferred)**
- Gateway sends WebSocket ping frame every 30 seconds
- Client responds with pong (handled automatically by WebSocket implementations)
- If no pong within 10 seconds → connection considered dead, trigger cleanup
- No application-level ping/pong needed — avoids JSON parsing overhead

**Why not app-level:**
- WebSocket ping/pong is handled by the protocol layer, zero application code on most clients
- Bun and Node `ws` both support automatic ping/pong
- OkHttp, URLSessionWebSocketTask, and browser WebSocket all handle pong automatically
- App-level heartbeat adds unnecessary message traffic and parsing

### Streaming Overlap (Latency Optimization)

**Critical for perceived responsiveness:**
```
Timeline:
  STT final → Classifier (5ms local / 400ms LLM) → LLM starts generating
                                                      ↓
                                                  First sentence complete
                                                      ↓
                                              TTS starts on first sentence
                                                      ↓
                                          Audio streaming to client begins
                                          (while LLM still generating next sentences)
```

- **Sentence boundary detection:** Gateway monitors LLM output stream for sentence-ending punctuation (`.!?`) and dispatches each complete sentence to TTS immediately
- **TTS pipelining:** Multiple TTS requests can be in-flight (sentence 1 streaming while sentence 2 encoding)
- **Client-side:** audio frames queue and play sequentially. No gap between sentences because next chunk arrives before current finishes.
- **Estimated latency reduction:** 50-70% vs waiting for full LLM response before TTS

### Audio Direction Signaling

**Problem:** Both client→gateway and gateway→client use binary frames for audio. How does the client know if an incoming binary frame is TTS audio vs some other binary data?

**Solution:** Directional context from control messages.
- `response.audio.start` signals: "binary frames from now are TTS audio"
- `response.audio.done` signals: "TTS audio stream complete"
- Between `audio.start` and `audio.end`, client is sending (gateway won't send binary)
- Between `response.audio.start` and `response.audio.done`, gateway is sending TTS
- Half-duplex audio by convention: one direction at a time (unless barge-in transitions)
- No ambiguity because audio flow is state-machine controlled

### Error Handling

**Error codes:**
| Code | Meaning | Client Action |
|------|---------|---------------|
| `stt_failed` | STT provider error | Retry utterance or switch to text input |
| `llm_failed` | LLM provider error | Display error, allow retry |
| `tts_failed` | TTS provider error | Display text response, skip audio |
| `tool_failed` | Tool execution error | Display error in tool result |
| `rate_limited` | Too many requests | Back off, show user message |
| `session_limit` | Max 10 sessions | Inform user, try later |
| `invalid_message` | Malformed JSON or unexpected type | Log and continue |
| `pipeline_timeout` | Response took >30s | Cancel and inform user |

**Graceful degradation:** If TTS fails, text response is still delivered. If STT fails, user can fall back to text input. Protocol supports mixed voice/text in same session.

## Comparison Matrix

| Dimension | A: WS + Opus | B: WS + PCM | C: Dual WS |
|-----------|-------------|-------------|------------|
| Bandwidth per session | ~48 kbps | ~512 kbps | ~48-512 kbps |
| Cellular viability | Excellent | Poor | Excellent |
| Codec complexity | High (per-platform) | None | Same as A/B |
| STT compatibility | Most accept Opus | All accept PCM | Same as A/B |
| Connection count (10 sessions) | 10 | 10 | 20 |
| Reconnection complexity | Simple | Simple | Double |
| Debug ease | Hard (binary) | Easy (.wav dump) | Hard |
| Gateway CPU | Transcode at boundaries | Passthrough | Same as A/B |
| Prototype speed | Slower (codec setup) | Faster | Slowest |
| Production readiness | Best | WiFi-only | Overengineered |

## Recommendation

**Start with Approach B (raw PCM) for prototyping, migrate to Approach A (Opus) for production.**

**Rationale:**
1. **PCM first:** Gets end-to-end audio flowing without any codec integration. All STT providers accept PCM natively. Validates the full pipeline (auth → audio → STT → classifier → LLM → TTS → playback) without codec distractions.
2. **Opus second:** Once pipeline works, add Opus encoding on clients. The protocol is codec-agnostic — `session.start` already declares `encoding`, so gateway handles both. Deepgram accepts Opus natively; others get gateway-side Opus→PCM transcode.
3. **Skip Approach C:** Dual channels add complexity with zero benefit at 10 sessions. Single WebSocket is proven (Discord used single WS for voice for years before scaling required separation).

**The protocol design (message types, lifecycle, reconnection, barge-in) is identical across A and B.** The only difference is the binary frame content. This makes the migration path clean — change client encoding and update `session.start.encoding`, everything else stays the same.

## Open Questions
- Should `session.start` support negotiation (client offers capabilities, server selects)? Probably overkill for 3 known client types.
- Should binary frames include a small header (timestamp, sequence)? Adds overhead but helps with jitter buffer on playback side. Decision: defer to TTS playback exploration.
- WebSocket compression (permessage-deflate): disable for binary audio (already compressed/incompressible), consider for text-heavy sessions? Probably just disable globally — text messages are tiny.
