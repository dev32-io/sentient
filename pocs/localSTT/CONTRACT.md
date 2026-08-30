# localSTT — Historical PoC Service Contract

> **HISTORICAL POC / NOT THE PRODUCTION CONTRACT.** This records the retired
> Raspberry Pi/SenseVoice experiment on port 8766. Production uses
> `capabilityServices/WhisperSTTService` on port 8768. Keep the details below as
> evidence for clients reproducing the PoC; do not use them to implement the
> active gateway integration.

A WebSocket service that consumes streamed microphone audio and emits
structured turn events. Wraps Silero VAD + Smart-Turn v3 + SenseVoice-Small
on the server side; to the caller it looks like a single black-box "STT
with VAD" component that speaks one turn at a time.

This document records the wire contract a client reproducing the PoC had to
honor. Stage-specific implementation details (Silero, Smart-Turn,
SenseVoice, the language allowlist, the pre-speech buffer) are deliberately
left out — they are internal and may change without breaking this contract.

---

## 1. Connection

| Property               | Value                                     |
| ---------------------- | ----------------------------------------- |
| Protocol               | WebSocket (RFC 6455), binary + text frames |
| Default endpoint       | `ws://<host>:8766`                        |
| Path                   | root (`/`)                                |
| Authentication         | None (network-scoped in current form)     |
| Sub-protocol           | None                                      |
| Max message size       | 16 MiB (server cap on inbound)            |
| Concurrent connections | Unbounded in principle; each holds per-connection VAD state (~20 MB) |

The service accepts and processes one WebSocket connection as a single
logical "session". Multiple sessions can run in parallel; per-session
state (VAD LSTM, per-turn buffers) is isolated, while the underlying
models (Silero, Smart-Turn, SenseVoice) are shared read-only and stateless
across sessions.

---

## 2. Audio format — hard requirement

The server expects **all binary WebSocket frames to be raw PCM16 audio
of the following format**:

- **Sample rate**: 16000 Hz (exact; no resampling is done server-side)
- **Channel count**: 1 (mono)
- **Sample format**: signed 16-bit little-endian integers (`int16_le`)
- **Framing**: continuous stream; no header, no WAV wrapper, no chunking
  requirements. The client may send frames of any byte length; the server
  rechunks internally to the 512-sample windows Silero requires.

Any deviation from this format (48 kHz, 24-bit, stereo, float32, WAV
header) produces garbage transcripts and incorrect VAD behavior. The
server does not detect or correct format mismatches — it trusts the
first byte of every binary frame to be the low byte of a 16-bit mono
sample.

---

## 3. Connection lifecycle

```
Client                                 Server
  │                                       │
  ├─── WebSocket handshake ──────────────►│
  │◄── 101 Switching Protocols ───────────┤
  │                                       │
  │◄── {"type":"ready", ...} ─────────────┤  (server is ready to receive audio)
  │                                       │
  ├─── {"type":"hello", ...} ────────────►│  (optional; logged only)
  │                                       │
  ├─── <binary PCM16 frame> ─────────────►│  (stream starts)
  ├─── <binary PCM16 frame> ─────────────►│
  ├─── ...                                │
  │                                       │
  │◄── {"type":"turn_complete", ...} ─────┤  (a turn was finalized)
  │◄── <binary WAV payload> ──────────────┤  (the turn's audio)
  │◄── {"type":"transcript_ready", ...} ──┤  (the transcript)
  │                                       │
  ├─── <binary PCM16 frame> ─────────────►│  (stream continues for next turn)
  ├─── ...                                │
  │                                       │
  ├─── WebSocket close ──────────────────►│
  │                                       │
```

**Invariants**:

1. The server sends exactly one `ready` message per connection, as the
   first text message, before accepting audio. The client **must wait for
   `ready`** before sending audio, or early frames may be dropped.
2. The server never initiates a connection close under normal operation.
   Graceful shutdown is the client's responsibility.
3. Audio streaming is one-directional (client → server). The server
   never sends audio back as "echo" or "loopback".

---

## 4. Input contract — client → server

### 4.1 Binary frames

Every binary WebSocket frame is interpreted as **raw PCM16 audio**. See
§2. There is no framing or sequencing metadata; the server assumes a
contiguous stream and rechunks internally.

Frame size is at the client's discretion. Typical clients send 32–64 ms
worth of audio per frame (1024–2048 bytes); the server handles anything
from a single sample up to 16 MiB per frame.

### 4.2 Text frames (JSON control messages)

| Type      | Direction | Purpose                                         | Required? |
| --------- | --------- | ----------------------------------------------- | --------- |
| `hello`   | C → S     | Optional handshake; logged for debugging.       | No        |
| `ping`    | C → S     | Liveness probe; server replies `pong`.          | No        |

#### `hello`

```json
{
  "type": "hello",
  "sampleRate": 16000,
  "client": "my-gateway/1.2.3"
}
```

Optional. The server logs the payload and, if `sampleRate` is present
and not equal to 16000, emits a `warning` text message back. Not sending
a `hello` has no functional impact.

#### `ping`

```json
{ "type": "ping" }
```

The server replies with `{"type": "pong"}`. Useful for idle-connection
keepalive if any intermediary closes idle WebSockets.

> **Note on language handling**: the service does **not** expose a
> language preference or per-session language hint. SenseVoice runs
> in multilingual auto-detect mode; the gateway is expected to handle
> language-related interpretation downstream via its LLM system
> prompt. See README § "Recommended integration pattern" for the
> rationale.

---

## 5. Output contract — server → client

The server emits two kinds of messages:

- **Text frames**: JSON objects with a `"type"` discriminator.
- **Binary frames**: raw WAV file bytes, emitted only immediately after
  a matching `turn_complete` text frame. No other binary payloads are
  sent.

### 5.1 Message types — summary

| Type                 | Frequency            | Binary follow-up? | Gateway should handle? |
| -------------------- | -------------------- | ----------------- | ---------------------- |
| `ready`              | Once on connect      | No                | **Yes** (gate audio)   |
| `warning`            | On config mismatch   | No                | Log and continue       |
| `pong`               | On `ping`            | No                | No                     |
| `vad_start`          | Per speech segment   | No                | Optional (debug/UX)    |
| `vad_end`            | Per speech segment   | No                | Optional (debug/UX)    |
| `smart_turn_eval`    | Per VAD end          | No                | Optional (debug)       |
| `turn_continuing`    | Per held-open pause  | No                | Optional (UX)          |
| **`turn_complete`**  | Per finalized turn   | **Yes, 1 WAV**    | **Yes** (if you want audio) |
| **`transcript_ready`** | Per finalized turn | No                | **Yes** (main signal)  |
| `turn_rejected`      | Per dropped turn     | No                | Optional (audit only)  |

**The two events a minimal gateway must handle are `ready` and
`transcript_ready`.** Everything else is either optional telemetry or a
companion binary payload.

---

### 5.2 Actionable events — what the gateway actually uses

#### `ready` (once per connection)

```json
{
  "type": "ready",
  "connId": "1a6614dab748",
  "sampleRate": 16000,
  "sileroChunkSamples": 512,
  "pcmFormat": "int16_le_mono",
  "stt": "sense-voice-small-int8"
}
```

Emitted as the first text message after connection open. The gateway
**must not send audio before receiving this**. All fields after `type`
are informational; the gateway can log them for observability.

#### `transcript_ready` — **the main payload**

```json
{
  "type": "transcript_ready",
  "turnIdx": 5,
  "text": "How about this. [pause.0] If I pause [pause.1] with a lot of [pause.2] how's that going work.",
  "emotion": "<|NEUTRAL|>",
  "event": "<|Speech|>",
  "decodeMs": 720.4,
  "audioSeconds": 7.8,
  "pauses": [1240, 870, 1530]
}
```

**Fields**:

| Field             | Type         | Guarantee                                                                                          |
| ----------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `type`            | string       | Always `"transcript_ready"`.                                                                       |
| `turnIdx`         | integer ≥ 1  | Monotonic per connection. Paired with the preceding `turn_complete.turnIdx`.                       |
| `text`            | string       | Contains exactly `len(pauses)` occurrences of `[pause.N]` tokens, indices 0..N-1 once each, in order. Always has ≥1 letter/digit character, OR the `event` is non-Speech (laughter, etc.). |
| `emotion`         | string       | SenseVoice tag form, typically `<\|NEUTRAL\|>` or `<\|EMO_UNKNOWN\|>`; occasionally other labels on exaggerated prosody. |
| `event`           | string       | SenseVoice tag form, typically `<\|Speech\|>`; other values include `<\|Laughter\|>`, `<\|BGM\|>`, `<\|Applause\|>`, `<\|Cough\|>`, `<\|Sneeze\|>`. |
| `decodeMs`        | float        | Total SenseVoice inference wall time for the turn, milliseconds.                                   |
| `audioSeconds`    | float        | Sum of speech-segment audio durations in seconds (excludes silence between segments).              |
| `pauses`          | int[] (ms)   | Durations of mid-turn silences, in order. Empty array when the turn had no mid-turn pauses.        |

> **No `language` field.** The service doesn't expose language
> detection on the wire. SenseVoice runs in auto-detect mode and
> transcribes code-switched text correctly, but you won't get a label
> telling you which language any given turn was. Language-aware
> downstream routing (TTS voice, LLM prompt) is the gateway's
> responsibility — typically handled via LLM system prompt rather
> than per-turn metadata.

**`text` invariant (important for gateway parsing)**:

```
len(pauses) == count of `[pause.N]` tokens in `text`
for each i in 0..len(pauses)-1: `[pause.i]` appears exactly once, and only in order
```

Gateway's recommended processing:

1. Strip SenseVoice tag wrapper from `emotion`/`event` if displaying
   (e.g. `<\|HAPPY\|>` → `HAPPY`). A regex of `/<\|([^|]*)\|>/` captures
   the inner code.
2. Pick a language-aware renderer for the pause placeholders. Since
   the service doesn't tell you the language, this is either a fixed
   rule for your household's primary language or inferred from the
   LLM's interpretation. See `pocs/localSTT/README.md` § "Pause
   markers for the LLM" for template implementations.
3. Pass the rendered text to the downstream LLM as the user's
   utterance, with language handling in the LLM system prompt.

#### `turn_complete` — optional companion

```json
{
  "type": "turn_complete",
  "turnIdx": 5,
  "durationMs": 7823.4,
  "smartTurnProbability": 0.8732,
  "smartTurnEvalMs": 87.3,
  "wavBytesLen": 250368,
  "wavPath": "/app/recordings/turn_1a6614dab748_005.wav"
}
```

Emitted only if the gateway cares about receiving the turn's audio. For
every `turn_complete`, **the next WebSocket frame from the server is a
single binary payload of `wavBytesLen` bytes containing the full turn's
WAV file (RIFF header + PCM16 samples)**.

The gateway can:
- Keep the WAV for playback, debugging, dataset collection, etc.
- Skip it by simply discarding the binary frame after parsing `turn_complete`.

**The `transcript_ready` message is emitted `wavBytesLen`-dependent ms
later**; the gateway should NOT assume `transcript_ready` has arrived
when `turn_complete` lands. See §5.4 ordering rules below.

`wavPath` is a server-side path for debugging; it's not accessible to
remote clients and should be treated as opaque metadata.

#### `turn_rejected` — optional audit

```json
{
  "type": "turn_rejected",
  "turnIdx": 5,
  "reason": "empty_transcript",
  "text": ".",
  "audioEvent": "<|Speech|>",
  "decodeMs": 83.4,
  "audioSeconds": 0.64
}
```

Emitted when the pipeline finalized a turn internally but decided the
transcript contained no actual letter/digit content AND the audio
event was plain `Speech` (e.g. a desk knock that fooled VAD). Turns
with meaningful non-speech events like `<|Laughter|>` or `<|BGM|>`
are NOT rejected even with empty text — the non-speech signal is
preserved via a normal `transcript_ready`.

**The gateway should silently ignore `turn_rejected` events** unless
it wants to audit/count false positives. No `turn_complete`, no WAV,
no `transcript_ready` are emitted for rejected turns.

`reason` values currently: `"empty_transcript"`. More may be added in
the future; gateways should treat unknown reasons as "ignore this
turn".

---

### 5.3 Debug / telemetry events

These exist for observability and live UI feedback ("assistant is
listening", "assistant is thinking") but are not required for
correctness. A gateway that only handles `ready` + `transcript_ready`
will work correctly.

| Type               | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `vad_start`        | Speech began (Silero fired start).                              |
| `vad_end`          | Speech paused (Silero fired end).                               |
| `smart_turn_eval`  | Smart-Turn evaluated whether the pause is the turn's end.       |
| `turn_continuing`  | Smart-Turn decided a pause is not the end; the turn stays open. |

All carry at minimum `{"type", "turnIdx"}` and relevant timing /
probability fields. See `pocs/localSTT/README.md` for field
reference.

---

### 5.4 Event ordering guarantees

Within a single turn, events arrive in this exact order:

```
vad_start (1 or more; once per speech segment)
vad_end   (1 or more; once per speech segment)
smart_turn_eval (1 or more; once per vad_end)
  ├─ (0 or more) turn_continuing      (each pause the turn held open)
  └─ (terminal)
       either:
         turn_complete  ─► binary WAV  ─► transcript_ready
       or:
         turn_rejected
```

**Strict ordering guarantees**:

1. A `turn_rejected` never co-occurs with `turn_complete` for the same
   `turnIdx`.
2. A `turn_complete` is **always** followed by a binary WAV frame of
   exactly `wavBytesLen` bytes. The gateway should track a "pending WAV"
   state until the binary frame arrives.
3. A `turn_complete` + binary WAV is **always** followed by a
   `transcript_ready` with the same `turnIdx`.
4. `turnIdx` values are monotonically increasing per connection. Gaps
   can occur if turns were rejected, but values never go backward.
5. Events for turn N fully complete before events for turn N+1 begin.
   There is no interleaving.

**Non-guarantees**:

- No latency bound between events. `transcript_ready` may arrive up to
  ~1 second after `turn_complete` depending on SenseVoice decode time.
- No clock synchronization. The server's `t_mono_ns` (not exposed on
  the wire) is server-local; wall-clock drift between client and server
  is out of scope.

---

## 6. Error handling

### 6.1 What the server reports

The server sends no error-specific wire events. In the current
implementation:

- **Audio format errors**: not detected. Wrong format → garbage output.
- **Model load failures**: the service doesn't accept connections if
  models fail to load (fails closed at startup).
- **Per-turn decode failures**: would surface as a `turn_rejected`
  with an unspecified reason (not implemented; SenseVoice rarely
  errors).
- **Internal exceptions**: the server logs them and closes the
  connection. The gateway sees a normal WebSocket close.

### 6.2 What the gateway should do

1. **Unexpected close**: treat as session-ended. Reconnect with
   exponential backoff. The service is stateless across connections;
   no handoff required.
2. **No `transcript_ready` within N seconds of `turn_complete`**:
   assume STT hung. The current implementation should not produce
   this case under normal load, but the gateway may want a 5–10 second
   guard.
3. **WebSocket ping/pong**: the gateway should implement
   application-level `ping`/`pong` if any intermediary closes idle
   connections. The service's own idle timeout is ~600 seconds (the
   default for Python `websockets`).
4. **Malformed JSON from server**: should not happen; if it does,
   log and drop that frame, continue the connection.

---

## 7. Operational constraints

| Constraint                         | Value                         | Notes                             |
| ---------------------------------- | ----------------------------- | --------------------------------- |
| Max audio per turn                 | Unbounded (buffer-limited)    | Practical limit: ~30 s per turn. Smart-Turn only sees the last 8 s. |
| Max silence before force-finalize  | 2000 ms                       | After a `turn_continuing`, the turn is force-closed if no new speech arrives. |
| Typical end-to-end tail latency    | 200–800 ms                    | VAD end → `transcript_ready`. Lower for short turns, higher for 8+ s monologues. |
| Concurrent connections             | Tested to 1; designed for 1–4 | Each connection holds ~20 MB of state; models are shared. |
| Server RAM (steady state)          | ~1.15 GB                      | With Silero (torch) + Smart-Turn + SenseVoice loaded. |
| Server CPU during active turn      | 1–2 cores briefly             | Burst during Smart-Turn + SenseVoice inference. |
| Target hardware                    | Raspberry Pi 5 (ARM64)        | Also runs on x86_64 linux/arm64.  |

---

## 8. Historical minimum client handler

The smallest correct client implementation in Python:

```python
import asyncio
import json
import websockets

async def run():
    async with websockets.connect("ws://raspberrypi.local:8766") as ws:
        # 1. Wait for ready (required before sending audio).
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready"

        async def send_mic_audio():
            # Your PCM16 LE mono @ 16 kHz source here.
            async for pcm_bytes in your_mic_source():
                await ws.send(pcm_bytes)

        async def handle_events():
            async for msg in ws:
                if isinstance(msg, bytes):
                    continue  # WAV payload — discard if you don't need it
                event = json.loads(msg)
                if event["type"] == "transcript_ready":
                    handle_transcript(event)
                # Ignore all other events for a minimal implementation.

        await asyncio.gather(send_mic_audio(), handle_events())

def handle_transcript(event):
    text = event["text"]             # may contain [pause.N] tokens
    pauses_ms = event["pauses"]      # int[] of millisecond durations
    language = event["language"]     # e.g. "<|zh|>"
    # Language-aware pause substitution, then pass to your LLM.
    text_for_llm = render_pauses(text, pauses_ms, language)
    forward_to_llm(text_for_llm)
```

That's the entire integration surface for the "happy path". Everything
else (debug events, binary WAV payloads, `turn_rejected`, `ping`/`pong`,
`vad_*` telemetry) is opt-in.

---

## 9. Versioning

This PoC predates any formal version scheme and did not graduate to the
supported production path. Reproductions must pin the corresponding repository
revision.
