# SDK-to-Gateway Contract — Alternative: Turn-Envelope Protocol

## Approach Name: `turn-envelope-protocol`

## Motivation

The first approach (utterance-lifecycle-contract) scored weakly on **StateComp (4)** and **TestIsol (2)**. The core issues:

1. **State explosion**: The utterance lifecycle introduces many correlated IDs (utteranceId, responseId) and implicit state dependencies between message types. Both sides must track which utterances map to which responses, handle overlapping lifecycles, and manage partial state on barge-in.

2. **Testing difficulty**: Testing the first approach requires constructing complex message sequences with correct ID threading. There's no simple way to replay or assert on a "turn" as an atomic unit.

This alternative simplifies by making the **turn** the atomic protocol unit, wrapping all messages in a sequenced envelope, and reducing the state each side must track.

## Design: Turn-Envelope Protocol

### Core Idea

Every message (both directions) is wrapped in a uniform envelope:

```typescript
interface Envelope<T = unknown> {
  turnId: string;      // groups all messages in one conversational turn
  seq: number;         // monotonically increasing per-connection
  type: string;        // message type discriminator
  payload: T;          // type-specific data
  ts: number;          // server timestamp (ms since epoch)
}
```

**Key simplification**: Instead of tracking `utteranceId` + `responseId` as separate correlation axes, everything belongs to a `turnId`. A turn is: user speaks → system transcribes → system responds → done. One ID rules them all.

### Why Envelopes Help

1. **Replay**: Any turn can be replayed by re-sending its envelope sequence. Testing becomes: record envelopes, replay envelopes, assert on output envelopes.
2. **Ordering**: `seq` numbers make ordering unambiguous. Lost messages detectable by gaps.
3. **Debugging**: Every message has a timestamp and sequence. Log the envelope stream and you have a complete protocol trace.
4. **Resumption**: On reconnect, client sends last-seen `seq`. Server replays from that point (if buffered).

### Binary Audio: Hybrid Envelope

Audio frames remain binary over WebSocket (no base64 overhead), but carry a minimal 8-byte header:

```
[turnId: 4 bytes (uint32 hash)] [seq: 4 bytes (uint32)]
```

This links binary frames to the envelope sequence without JSON overhead. The `turnId` hash is negotiated when the turn starts (server assigns it in the `turn.start` response).

Alternative (simpler): Audio frames don't carry any header. They are implicitly associated with the currently-active turn. Only one turn can have active audio at a time (enforced by state machine). This is the same assumption the current codebase makes.

**Recommendation**: Start with the simpler implicit association for v1. The 8-byte header is a v2 optimization for multi-stream scenarios.

### Message Types (Reduced Set)

#### Session Lifecycle (no turnId)
```typescript
// Envelope with turnId = "session"
session.configure  { mode, encoding, sampleRate, capabilities }
session.ready      { encoding, sampleRate, sessionId }
session.end        { reason }
```

#### Turn Lifecycle
```typescript
// Client → Gateway
turn.start         { }                    // "I'm about to speak"
turn.audio         [binary frames]        // implicit turn association
turn.end           { }                    // "I'm done speaking"
turn.cancel        { }                    // cancel current turn (barge-in = cancel + new turn.start)

// Gateway → Client  
turn.started       { turnId, turnHash }   // server confirms, assigns IDs
turn.transcript    { text, final: boolean } // partial or final (single type!)
turn.response.start { }                   // "thinking" indicator
turn.response.text  { text, done: boolean } // text token or final text
turn.response.audio.start { }
turn.response.audio [binary frames]       // implicit turn association
turn.response.audio.end { }
turn.response.end  { }                    // entire response complete
turn.cancelled     { partialText? }       // barge-in ack with truncated text
turn.error         { code, message, recoverable }

// Keepalive (no turnId needed, seq still increments)
ping               { }
pong               { }
```

**Total**: 8 client→gateway + 11 gateway→client = 19 types (vs 22 in first approach).

### Key Simplification: `transcript.partial` + `transcript.final` → `turn.transcript`

Instead of two separate message types for partial and final transcripts, use a single `turn.transcript` with a `final: boolean` flag. Same data, fewer types, simpler dispatch.

Similarly, `response.text.delta` + `response.text.done` → `turn.response.text` with `done: boolean`.

### State Machine (Per-Turn, Server Side)

```
                     turn.start
idle ──────────────────────────────→ receiving
  │                                    │
  │                                    │ turn.end
  │                                    ▼
  │                                transcribing
  │                                    │
  │                                    │ transcript(final=true)
  │                                    ▼
  │                                responding
  │                                    │
  │                                    │ turn.response.end
  │                                    ▼
  │◄──────────────────────────────── idle
  │
  │         turn.cancel (from any non-idle state)
  │◄──────────────────────────────── cancelled → idle
```

**Only 5 states** vs 7+ in the first approach. The envelope's `turnId` scoping means we don't need separate "processing" vs "speaking" states — those are sub-states of `responding` signaled by message types within the turn.

### State Machine (Client Side)

The SDK client mirrors with even fewer states:

```
idle → speaking → waiting → receiving → idle
         │                      │
         └──── cancel ──────────┘ → idle
```

4 states. The `waiting` state covers everything between `turn.end` and `turn.response.start`. The `receiving` state covers all response streaming (text + audio interleaved).

### Barge-In as Cancel + New Turn

Instead of a dedicated barge-in protocol:

```
CLIENT                              SERVER
[receiving response for turn-1]
turn.cancel { }  ──────────────→   abort turn-1 pipeline
                                   turn.cancelled { partialText: "..." }
turn.start { }   ──────────────→   turn.started { turnId: "turn-2" }
[binary audio]   ──────────────→   ...
```

Barge-in is just: cancel current turn, start new turn. No special `barge_in` / `barge_in.ack` message types needed. The `turn.cancel` → `turn.cancelled` pair handles it.

### Error Scoping

Every error is scoped to a turn (via the envelope's `turnId`):

```typescript
turn.error {
  code: "transcription_failed" | "response_failed" | "provider_timeout" | "rate_limited",
  message: string,       // human-friendly
  recoverable: boolean   // SDK auto-retries or surfaces to user
}
```

Session-level errors use `turnId = "session"`:
```typescript
// turnId = "session"
turn.error {
  code: "auth_failed" | "session_expired" | "protocol_error",
  message: string,
  recoverable: false
}
```

### Codec Negotiation (Same as First Approach)

The `session.configure` / `session.ready` handshake is identical — this is orthogonal to the envelope vs flat message question. Reused as-is.

### Versioning

Envelope includes version in session handshake. Unknown fields in envelope are ignored (forward-compatible). Unknown message types trigger `turn.error { code: "protocol_error" }`.

Subprotocol negotiation: `Sec-WebSocket-Protocol: sentient-voice-v1`

## Comparison With First Approach

| Dimension | First Approach (utterance-lifecycle) | This Approach (turn-envelope) |
|-----------|--------------------------------------|-------------------------------|
| **Correlation IDs** | utteranceId + responseId (2 axes) | turnId only (1 axis) |
| **Message types** | 22 total | 19 total |
| **Client states** | 7+ (inactive, listening, user-speaking, processing, assistant-speaking, reconnecting, error) | 4 (idle, speaking, waiting, receiving) + session states |
| **Server states per turn** | Complex (must track utterance→response mapping) | 5 linear states |
| **Testing** | Must thread correct IDs through sequences | Record envelope stream, replay it. Assert on seq + type. |
| **Barge-in** | Dedicated barge_in/barge_in.ack | Generic turn.cancel/turn.cancelled |
| **Transcript types** | 2 (partial + final) | 1 with flag |
| **Binary framing** | No metadata | Optional 8-byte header (v2) |
| **Replay/debug** | Reconstruct from logs | seq-numbered stream, trivially replayable |

## Tradeoffs

### Advantages
1. **Simpler state**: Fewer states, single correlation axis, linear turn lifecycle
2. **Testing**: Envelope streams are trivially recordable and replayable — addresses TestIsol weakness
3. **Debugging**: Every message has seq + timestamp → protocol traces are unambiguous
4. **Resumption**: seq-based resume on reconnect is a natural extension
5. **Fewer message types**: Collapsing partial/final into flags reduces dispatch surface

### Disadvantages
1. **Envelope overhead**: Every JSON message gains ~40 bytes of envelope wrapper. Negligible for text, but it's there.
2. **No multi-turn overlap**: One turnId at a time. If future requirements need concurrent turns (user speaks while previous response plays), would need to add stream multiplexing.
3. **Binary header complexity**: If we add the 8-byte binary header, both sides need to parse it. If we don't, binary frames are implicitly scoped (same limitation as current code).
4. **Turn atomicity assumption**: Some future features (tool calls mid-response, multi-step reasoning) might not fit cleanly into the turn model. Would need sub-turns or nested envelopes.

## Codebase Integration Points

Same touch points as first approach, but with simpler handler logic:

- `shared/protocol/src/messages.ts` — define `Envelope<T>` wrapper + reduced message type set
- `shared/protocol/src/envelope.ts` (new) — envelope encode/decode, seq counter, turnId generation
- `gateway/src/server/ws-server.ts` — unwrap envelope, route by `type`, track seq per connection
- `gateway/src/pipeline/voice-session.ts` — replace utterance tracking with turn state machine
- `web/src/hooks/use-websocket.ts` — wrap outgoing messages in envelopes, track incoming seq for gap detection

## Testing Approach (Key Differentiator)

The envelope protocol enables a **record/replay testing pattern** that directly addresses the TestIsol weakness:

```typescript
// Record a live session
const recorder = new EnvelopeRecorder();
ws.on('message', (msg) => recorder.record(parseEnvelope(msg)));
// ... run session ...
recorder.save('fixtures/normal-turn.json');

// Replay in tests
const fixture = loadFixture('fixtures/normal-turn.json');
const mockTransport = new MockTransport(fixture.serverMessages);
const client = new VoiceClient(mockTransport);

// Assert client state transitions match expected
for (const expected of fixture.expectedStates) {
  await mockTransport.deliverNext();
  expect(client.state).toBe(expected);
}
```

Contract tests become: "given this envelope sequence, does the other side produce the correct envelope sequence?" Pure input→output, no mocking internals.

## Open Questions

1. **Seq gap handling**: If client detects a seq gap, should it request retransmission or just log a warning? WebSocket is TCP-based so gaps shouldn't happen unless server intentionally drops.
2. **Turn timeout**: How long can a turn stay in `transcribing` or `responding` before auto-cancelling? Should be configurable in `session.configure`.
3. **Text input turns**: `text.input` could be modeled as a turn with no audio phase — `turn.start` + `turn.text` + `turn.end`. Or kept as a separate fast-path. The turn model accommodates both.
4. **Multi-modal future**: If adding image/video input, each would be a new frame type within the turn envelope. The envelope structure supports this without protocol changes.
