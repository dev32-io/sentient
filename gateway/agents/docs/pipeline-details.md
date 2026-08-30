# Native Gateway Pipeline — Details

## Owners

| Component | File | Responsibility |
|---|---|---|
| `SessionRuntime` | `../../src/runtime/session-runtime.ts` | One durable session, turn serialization, cancellation, committed feed, task projection, and retention signals. |
| ReAct loop | `../../src/runtime/react-loop.ts` | Provider iterations, text streaming, tool dispatch, and durable loop output. |
| Session store | `../../src/store/session-store.ts` | Append-only source of truth for model and client projections. |
| `ToolBroker` | `../../src/tools/tool-broker.ts` | Role, permission, capability, validation, timeout, and foreground/background dispatch policy. |
| Turn voice | `../../src/runtime/turn-voice.ts` | Forks streamed text to TTS under the turn's cancellation signal. |
| Fan-out emitter | `../../src/session-handlers/fan-out-emitter.ts` | Allocates each session frame once, journals it, and sends identical bytes to attached windows. |

A turn is the externally visible unit of work. `SessionRuntime` mints its
`turnId`, emits `turn.started`, runs the ReAct loop, commits the final reply,
and emits `turn.completed` or `turn.aborted`.

## Serialization and steering

There is at most one active turn per durable session. A stimulus is appended to
the store before dispatch:

- If the runtime is idle, it starts a turn.
- If a turn is active, no second turn starts concurrently. The active ReAct
  loop re-reads the store at the beginning of every iteration, so newly
  appended input can steer it without a second queue or conversation mirror.
- When the turn settles, `SessionRuntime` compares the loop's consumed
  high-water mark with later user/background trigger entries. Any stimulus the
  loop did not consume starts a back-to-back turn.

Only `user` and `trigger` entries can start turns. Assistant, tool, system, and
compaction entries are loop output and never self-trigger another turn.

## ReAct loop

For every iteration, `runTurn`:

1. Reads the session store and builds the model projection.
2. Calls the configured OpenAI-compatible provider with an immutable tool set.
3. Streams text through `turn.text.delta` and the turn's TTS stream.
4. Appends each requested `tool_call`, dispatches it through `ToolBroker`, and
   appends its `tool_result` before the next provider iteration.
5. Commits the terminal assistant entry when no further tool call is requested.

`orchestrator.loop.max_iterations` bounds the loop. The final allowed iteration
receives no tools, forcing a content-only answer rather than ending silently on
a tool request. Provider calls and stream gaps are deadline-bounded and receive
the turn's `AbortSignal`.

## Foreground and background tools

Foreground calls settle inside the current loop iteration. Background calls
return a task receipt immediately; delegated work continues independently and
its eventual result returns as a `background-completion` stimulus. That
stimulus can steer an active turn or start a new one.

Live tool UI is `tasklist.state`, a full-state composer strip. Tool call/result
entries remain in the store for the model projection but are not conversation
feed items. Hermes may be used only behind the bounded, one-shot
`delegateTask` path.

## Cancellation

`SessionRuntime.bargeIn()` and `SessionRuntime.interrupt()` both:

- abort the current turn signal when a turn is active;
- stop this session's draining TTS;
- emit `playback.stop` so clients flush queued audio;
- commit any partial assistant output with `barge-in` or `interrupt` cutoff;
- emit `turn.aborted` for the active turn.

They do not cancel background work. Background completion is still appended and
processed later. A new turn by itself never stops earlier audio.

## STT and TTS

The native gateway reaches both capability services over loopback:

- whisper-stt: `ws://127.0.0.1:8768`
- LocalTTSService: `ws://127.0.0.1:8770`

The STT service owns VAD, semantic turn detection, and transcription. PCM input
is downsampled to 16 kHz by the adapter; Opus packets are forwarded for
service-side decoding. LocalTTSService receives text control frames and emits
binary Opus audio at 48 kHz.

## Wire summary

Client input includes `text.input`, `audio.start`, binary audio, `audio.end`,
`interrupt`, and `permission.response`. Session output includes:

- `turn.started`, `turn.text.delta`, `turn.completed`, `turn.aborted`
- `turn.audio.start`, binary audio, `turn.audio.done`
- `conversation.entry` and attach-time `conversation.snapshot`
- `tasklist.state`, `permission.*`, `delegation.progress`
- `playback.stop`

The exact contract is [`../../../shared/protocol/WIRE.md`](../../../shared/protocol/WIRE.md).
