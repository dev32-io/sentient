# Turn Audio Queue

The SDK's `TurnAudioQueue` (`shared/web-sdk/src/turn-audio-queue.ts`) enforces
strict FIFO playback ordering across turns: at most one turn's audio plays at a
time, and a turn's audio is never cancelled, faded, or replaced by a later turn
— it queues behind whatever is already playing (spec §7.2; the gateway never
stops its own audio). This replaced the pre-2.0 `CycleAudioQueue`, which
preempted the active stream with a fade once a `minEagerEndMs` cap elapsed —
that behavior is incompatible with 2.0's back-to-back follow-up turns (§4.5): a
follow-up turn's audio must never cut off the turn that triggered it.

The queue lives in the SDK, not the app, so every client platform inherits the
same ordering guarantee. The webui just constructs it over its playback adapter
(`createTurnAudioQueue({ playback })`) and feeds it decoded frames.

## State

- `queue: TurnSlot[]` — FIFO; `queue[0]` is the turn currently feeding playback.
  Arbitrary depth, not capped at one pending slot.
- `TurnSlot = { turnId, buffered: Float32Array[], doneReceived: boolean }`
- `hasPendingAudio` — true between an `enqueue` and the drain that follows it.

## Rule

- A turn is appended to the tail on `turn.audio.start`. Frames for the head go
  straight to playback; frames for any other turn buffer in that turn's slot.
- `playback.onDrain()` retires the head and promotes the next slot (FIFO)
  **only if** the head's `doneReceived` flag is set — never on a timer, never
  because a newer turn arrived.
- `turn.audio.done` arriving AFTER playback already drained also retires the
  head (guarded by `!hasPendingAudio`). Without this the queue would wedge: no
  further drain event will ever fire for an already-drained pipeline.
- `cancelAll()` — the **only** path that clears an in-flight turn — wipes the
  queue and calls `playback.clear()` (hard stop, no fade). Called exclusively
  from barge-in / interrupt.

## Configuration

None. There is nothing to tune — no preempt cap, no fade duration. The pre-2.0
`session.ready.playback` tunables (`min_eager_end_ms` / `preempt_fadeout_ms`)
are dropped from `SessionReadyPayload`; if a gateway build still sends them, the
client ignores them.

## Implementation

- `shared/web-sdk/src/turn-audio-queue.ts` — the queue itself
- `gateway/webui/src/adapters/web-audio-playback.ts` — satisfies the queue's
  `TurnAudioPlayback` port through `enqueue` / `clear` / `onDrain`. Its
  `fadeOutAndClear` capability no longer has a caller here but stays on the
  adapter — it's an independently tested generic playback capability.
- `gateway/webui/src/hooks/use-voice-client.ts` — constructs the queue and
  routes `turn.audio.*` + decoded opus frames into it.

## Non-goals

- This layer does **not** do per-sentence cut-in, crossfades, or multi-stream
  mixing. One turn plays at a time. If design ever needs cross-turn mixing, a
  different layer should sit above this queue.
- This layer does **not** decide when to stop. Only barge-in (mic onset) and
  interrupt (UI Stop) flush audio, and both reach it through `cancelAll()`.
