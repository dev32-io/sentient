# local-tts — Service Contract

A WebSocket service that turns streamed text into streamed audio. Wraps
Qwen3-TTS (MLX, Apple Silicon / Metal) behind a black-box "text in,
audio out" component with a small side-channel for voice-pack management
(clone-a-voice from a reference clip, list, delete).

This document specifies the wire contract a gateway client must honor to
integrate. Implementation details (the MLX model, the resample/encode
pipeline, the worker-thread synthesis design) are deliberately left out —
see the source (`server.py`, `synthesis.py`, `synth_worker.py`) for those;
they are internal and may change without breaking this contract.

---

## 1. Connection

| Property               | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| Protocol                | WebSocket (RFC 6455), binary + text frames                   |
| Default endpoint        | `ws://127.0.0.1:8770` (bind is loopback-only; not exposed off-host) |
| Path                    | root (`/`); optional query params `?format=`, `?sample_rate=`, `?voice=` (§1.1) |
| Authentication          | None — trusted local deployment; the gateway is the sole consumer |
| Max message size        | `server.max_message_bytes` in `config.yaml` (default 16 MiB) |
| Concurrent connections  | Unbounded in principle; synthesis itself is globally serialized (§7) regardless of connection count |

### 1.1 Connect-time negotiation

Clients MAY specify the audio format, output sample rate, and voice via
a URL query string on the WebSocket connect URL:

    ws://127.0.0.1:8770/?format=opus&sample_rate=48000&voice=<voiceId>

| Param         | Accepted values          | Default (when absent or invalid)         |
| ------------- | ------------------------- | ----------------------------------------- |
| `format`      | `opus`, `pcm`              | `config.default_format` (normally `opus`) |
| `sample_rate` | any positive integer       | `config.default_sample_rate` (normally `48000`) |
| `voice`       | a `voiceId` from `voice.list`, or absent | absent / unknown -> the model's built-in default voice |

An unrecognized `format` or a non-integer `sample_rate` falls back to
the configured default with a server-side warning log (never rejects
the handshake). An absent or unknown `voice` silently resolves to the
model's built-in default voice at synthesis time — there is no error
for "voice not found," by design (a deleted or mistyped voice should
degrade to "default voice," not break the connection).

All three params are echoed back on the `ready` frame (§5) — the client
should treat that as the source of truth for what was actually
negotiated, not what it requested.

Every param composes independently; absence of any yields its default.

### 1.2 One connection, many requests

A single connection is not one-shot: the client can send any number of
text -> flush/end cycles over the connection's lifetime (e.g. one
synthesis request per LLM sentence, or one per cognitive cycle). The
service never closes the connection on its own initiative — that is
always the client's call.

---

## 2. Connection lifecycle

```
Client                                        Server
  │                                              │
  ├─── WebSocket handshake ─────────────────────►│
  │◄── 101 Switching Protocols ───────────────────┤
  │                                              │
  │◄── {"type":"ready", ...} ─────────────────────┤  (negotiated format/sample_rate/voice)
  │                                              │
  ├─── {"type":"text","text":"Hello"} ───────────►│  (buffered, not yet synthesized)
  ├─── {"type":"text","text":", world."} ────────►│  (buffered, appended)
  ├─── {"type":"flush"} ─────────────────────────►│  (synthesize the buffered text now)
  │                                              │
  │◄── {"type":"started","requestId":"..."} ──────┤
  │◄── <binary audio frame> ──────────────────────┤
  │◄── <binary audio frame> ──────────────────────┤  (one or more, streamed)
  │◄── {"type":"done","requestId":"...", ...} ────┤
  │                                              │
  ├─── {"type":"text","text":"More."} ───────────►│  (next request's text starts buffering)
  ├─── {"type":"end"} ────────────────────────────►│  (same as flush: synthesize what's buffered)
  │◄── started -> binary(s) -> done ──────────────┤
  │                                              │
  ├─── WebSocket close ───────────────────────────►│  (client-initiated; connection is reusable
  │                                              │   across many requests until then)
```

**Invariants**:

1. The server sends exactly one `ready` message per connection, as the
   first message, before anything else. Clients should treat frames
   received before `ready` as impossible / a protocol violation.
2. The server never initiates a connection close under normal
   operation. Graceful shutdown is the client's responsibility.
3. `flush` and `end` behave identically today: both synthesize whatever
   text is currently buffered (no-op if nothing is buffered) and reset
   the buffer. `end` carries no additional "close the connection"
   semantics — see §1.2. The distinction is kept on the wire so a
   future version can special-case `end` (e.g. flush + close-after-drain)
   without a breaking change.
4. Requests on one connection are processed **in the order flushed**,
   never interleaved (see §7's concurrency model) — a second `flush`
   sent while a request is still streaming queues behind it locally,
   and additionally may queue behind requests from *other* connections
   (the whole service allows only one synthesis in flight at a time).

---

## 3. Input contract — client → server

### 3.1 Text frames (JSON control messages)

| Type            | Purpose                                                    | Required fields        |
| ---------------- | ------------------------------------------------------------ | ------------------------ |
| `text`           | Append a text delta to the buffer (not yet synthesized).    | `text` (string)          |
| `flush`          | Synthesize the buffered text now (sentence boundary).       | —                        |
| `end`            | No more text is coming for this request; same as `flush`.   | —                        |
| `cancel`         | Abort the in-flight request immediately; drop queued-but-unstarted ones. | — |
| `ping`           | Liveness probe; server replies `pong`.                      | —                        |
| `voice.create`   | Start a voice-pack upload; **must be followed by exactly one binary frame** (the reference clip — wav / flac / ogg / mp3, content-sniffed; 10-15s recommended, hard floor >5s). | `name` (string) |
| `voice.list`     | List every persisted voice pack.                             | —                        |
| `voice.delete`   | Delete a voice pack by id.                                    | `voiceId` (string)       |

Any message with an unrecognized `type`, invalid JSON, or a missing
required field produces an `{"type":"error", reason}` reply — the
connection is never dropped for a malformed message.

#### `text`

```json
{ "type": "text", "text": "Hello, " }
```

Appends to an internal per-connection buffer. Send as many as needed;
nothing is synthesized until `flush`/`end`.

#### `flush` / `end`

```json
{ "type": "flush" }
```

Synthesizes whatever text has been buffered since the last flush (joins
all `text` deltas in order, then clears the buffer). No-op if nothing
is buffered — no `started`/`done` pair is emitted for an empty flush.

#### `cancel`

```json
{ "type": "cancel" }
```

Sets the in-flight request's cancellation signal and drops any
already-queued-but-not-yet-started requests on this connection. The
in-flight request still emits a normal `done` (with whatever partial
`audio_seconds` it managed before stopping) rather than an error — see
§6.2.

#### `ping`

```json
{ "type": "ping" }
```

Server replies `{"type": "pong"}` immediately (no synthesis lock
needed).

### 3.2 Binary frames

The **only** binary frame the server expects from a client is the
reference-clip upload immediately following a `voice.create` message.
Any other binary frame produces a
`{"type":"warning", reason:"unexpected_binary_frame"}` and is otherwise
ignored.

---

## 4. Voice management

### 4.1 `voice.create`

```json
{ "type": "voice.create", "name": "Dad", "description": "Warm, low register", "tags": ["family", "warm"] }
```

`description` and `tags` are both optional — omit either (or send
`description: ""` / `tags: []`) for a bare-name pack. `description` is
a plain string; `tags` is a list of strings. Neither is currently
length/count-validated at the wire layer (limits exist in
`config.yaml` as `voice_description_max_len` / `voice_tag_max_len` /
`voice_max_tags` for a future enforcement pass — not yet wired up).

The `voice.create` message is followed by one binary WebSocket frame
containing a reference clip in wav / flac / ogg / mp3 — any container
`soundfile` (libsndfile >=1.1) can decode, content-sniffed so the client
need not declare the format (any sample rate/channel count; multi-channel
is mixed down to mono). Rejected with `{"type":"error", reason:"..."}` if:

- the clip decodes to ≤5 seconds of audio (voice-pack quality floor,
  enforced by `VoiceStore.create` — see its docstring for the exact
  threshold), or
- the bytes don't decode as audio at all.

On success:

```json
{ "type": "voice.created", "voiceId": "3f9b...", "name": "Dad", "createdAt": 1752400000.0 }
```

A voice created this way always lands in the user-created set — see
§4.4 for how it relates to the read-only built-in library.

`voice.create` only writes a reference wav to disk — it does not touch
the shared model — but it still runs under the same lock as text
synthesis for simplicity (see `connection_session.py`): a `voice.create`
in flight blocks (and is blocked by) every synthesis request on every
connection, and vice versa.

### 4.2 `voice.list`

```json
{ "type": "voice.list" }
```

```json
{
  "type": "voice.list",
  "voices": [
    { "voiceId": "nova", "name": "Nova", "description": "", "tags": ["warm"], "createdAt": 0.0, "refDurationMs": 0, "source": "builtin" },
    { "voiceId": "3f9b...", "name": "Dad", "description": "Warm, low register", "tags": ["family", "warm"], "createdAt": 1752400000.0, "refDurationMs": 12000, "source": "user" }
  ]
}
```

Every item carries `source`: `"builtin"` for a read-only, service-packaged
voice pack, or `"user"` for one created via `voice.create` on this host.
Built-in packs are always listed first (see §4.4), each sorted by
`voiceId`; user packs follow, sorted by `voiceId`. `description`/`tags`
default to `""`/`[]` for older packs created before those fields
existed (Task 1).

Does not touch the synthesis lock — safe to call while a request is in
flight.

### 4.3 `voice.delete`

```json
{ "type": "voice.delete", "voiceId": "3f9b..." }
```

```json
{ "type": "voice.deleted", "voiceId": "3f9b..." }
```

**Idempotent**: deleting a voice that doesn't exist (or was already
deleted) still replies `voice.deleted` — deletion is a "make it not
exist" operation, not an existence assertion. A structurally invalid
`voiceId` (path-traversal shape, wrong length/alphabet — see
`voice_store.py`'s security notes) replies `error` instead.

Deleting a **built-in** voice (`source: "builtin"` in `voice.list`)
always replies `{"type":"error", "reason":"builtin-voice"}` instead of
`voice.deleted` — the built-in library is read-only by design; see §4.4.

### 4.4 Built-in voice library

Alongside user-created packs, the service ships a small, read-only set
of built-in voice packs (`config.yaml`'s `builtin_voice_dir`, default:
a `voices_library/` directory packaged with the service). Built-in
voices are addressed by a short slug (e.g. `"nova"`) rather than the
`uuid4().hex` shape `voice.create` mints — both id shapes are valid
`voiceId` values everywhere a `voiceId` is accepted (`?voice=` query
param, `voice.delete`).

Client-visible differences from a user-created pack:

- `voice.list` tags it `"source": "builtin"` and lists it ahead of
  every `"source": "user"` pack.
- `voice.delete` on a built-in `voiceId` always fails with
  `{"type":"error", "reason":"builtin-voice"}` — never succeeds, never
  falls into the idempotent "already deleted" path described in §4.3.
- Selecting one via `?voice=<slug>` and synthesizing works exactly like
  a user-created pack — the built-in/user distinction is invisible to
  synthesis.

---

## 5. Output contract — server → client

### 5.1 Message types — summary

| Type              | Frequency                     | Binary follow-up? | Client should handle?   |
| ------------------ | -------------------------------- | -------------------- | -------------------------- |
| `ready`            | Once on connect                  | No                    | **Yes** (confirms negotiated params) |
| `started`          | Once per synthesis request       | No                    | Optional (UX: "speaking started") |
| *(binary frame)*   | One or more per request          | —                     | **Yes** (the audio)        |
| `done`             | Once per synthesis request       | No                    | **Yes** (metrics + "response fully sent") |
| `warning`          | On a non-fatal condition         | No                    | Log and continue           |
| `error`            | On a failed request/upload       | No                    | **Yes** (surface to user / retry) |
| `pong`             | On `ping`                        | No                    | No                          |
| `voice.created`    | On `voice.create` success        | No                    | **Yes**                     |
| `voice.list`       | On `voice.list`                  | No                    | **Yes**                     |
| `voice.deleted`    | On `voice.delete`                | No                    | **Yes**                     |

#### `ready` (once per connection)

```json
{ "type": "ready", "format": "opus", "sample_rate": 48000, "voice": null }
```

Emitted as the first message. `voice` is `null` when the client didn't
request one (the built-in default voice is used, with no assigned id).

#### `started` (once per request)

```json
{ "type": "started", "requestId": "a1b2c3d4e5f6" }
```

`requestId` is a fresh opaque id per request (not stable across
requests, not derived from any client-supplied value).

#### Binary audio frames

Each binary frame is one already-encoded chunk from `make_encoder(format,
sample_rate).encode(...)` — OGG-Opus page bytes when `format=opus`, raw
PCM16-LE samples when `format=pcm`. Frame boundaries carry no semantic
meaning (not "one frame per sentence" etc.) — concatenate all frames
between `started` and `done` to reconstruct the full response audio.

#### `done` (once per request)

```json
{ "type": "done", "requestId": "a1b2c3d4e5f6", "ttfa_ms": 187.42, "rtf": 0.31, "audio_seconds": 2.75 }
```

| Field           | Meaning                                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| `ttfa_ms`        | Time-to-first-audio: wall time from request start (including any lock wait) to the first binary frame actually sent. |
| `rtf`            | Real-time factor: total processing wall time / `audio_seconds`. <1.0 means faster than real-time playback speed. |
| `audio_seconds`  | Total duration of the synthesized audio (source-rate PCM sample count / 24000 — exact regardless of `format`). |

A cancelled request still emits `done` (not an error) with whatever
partial `audio_seconds` it produced before stopping — see §6.2.

#### `warning` / `error`

```json
{ "type": "warning", "reason": "unexpected_binary_frame" }
{ "type": "error", "reason": "reference clip too short: need >5s, got 2.10s" }
```

`warning` never terminates a request; `error` means the request/upload
that triggered it failed, but the connection stays open and usable for
the next request.

---

## 6. Concurrency + error handling

### 6.1 Why synthesis is globally serialized

`QwenEngine.synthesize()` takes its reference audio as a plain per-call
argument, so concurrent calls do not race over shared model state.
It is, however, still a blocking, synchronous generator on a single
GPU/model (see `engine.py`) — two requests running at once would just
fight over the same Metal device, with no throughput benefit.

Consequently the service holds one process-wide lock for the full
duration of every text-synthesis request **and** every `voice.create`
(kept under the same lock for simplicity, not because it touches the
shared model — see `connection_session.py`) — across every connection.
`voice.list`/`voice.delete`/`ping` never wait on this
lock. Practical effect: with N connections all synthesizing at once,
requests complete one at a time, each connection's `started` may arrive
noticeably after the client's `flush`, and reported `ttfa_ms` includes
any lock-wait time (this is intentional — it reflects the latency the
client actually experiences).

### 6.2 `cancel` / disconnect mid-synthesis

Setting the cancel signal (`cancel` message, or the WebSocket closing)
stops audio generation at the next internal chunk boundary — a partial
utterance, not a clean sentence break. The service does not attempt to
resynthesize or retry. A `cancel` still yields a normal `done` (see
§5.1); a disconnect obviously yields nothing (there is no client left
to send to).

### 6.3 What the client should do

1. **Unexpected close**: treat as session-ended. Reconnect and re-send
   `?format=&sample_rate=&voice=` as before — the service holds no
   client-visible session state across connections (voice packs are
   the only persistent state, and they're addressed by `voiceId`, not
   by connection).
2. **`error` on a request**: the connection is still usable — retry the
   same text, or move on.
3. **No `done` within N seconds of `started`**: treat as hung and
   consider reconnecting; there is currently no server-side timeout
   guard on a stuck synthesis call.

---

## 7. Operational constraints

| Constraint                         | Value                                    | Notes |
| ------------------------------------ | -------------------------------------------- | ------- |
| Concurrent synthesis                | Exactly 1, globally                          | Enforced by the process-wide lock (§6.1); more connections do not add synthesis throughput. |
| Reference clip floor (`voice.create`) | >5 seconds                                  | Enforced before any filesystem work; shorter clips are rejected with `error`, no partial pack persisted. |
| Target hardware                     | Apple Silicon (Mac mini)                     | MLX has no Linux/x86 backend. |
| Server RAM (steady state)           | Qwen3-TTS-12Hz-0.6B-Base-8bit weights ≈ 1.9 GB | Plus warm voice-pack cache; coexists with native Whisper-STT + the Docker gateway stack on the same host. |

---

## 8. Versioning

Pin your gateway to a specific commit of this repository — there is no
`serverVersion` field on `ready` yet (matches the STT service's current
state; both are expected to grow one together when either graduates
past "single first-party consumer").
