# Turn audio queue

`shared/web-sdk/src/turn-audio-queue.ts` provides strict FIFO playback keyed by `turnId`. The web UI constructs it with `createTurnAudioQueue({ playback })`; it does not implement a second queue.

- `turn.audio.start` creates a tail slot.
- Frames for the head go to playback; frames for later turns stay in their slot.
- `turn.audio.done` marks the slot complete.
- `playback.onDrain()` retires a completed head and promotes the next slot.
- If done arrives after the pipeline drained, the queue retires that head without waiting for another drain event.
- `cancelAll()` is the only flush path. Barge-in and the Interrupt action use it to clear buffered audio and call playback `clear()`.

A later turn never preempts, fades, or replaces audio already playing. There is no eager-end cap or fade configuration. The gateway owns turn boundaries; the SDK owns playback ordering.

Relevant code:

- `shared/web-sdk/src/turn-audio-queue.ts`
- `gateway/webui/src/adapters/web-audio-playback.ts`
- `gateway/webui/src/hooks/use-voice-client.ts`

Tests should pin FIFO promotion, late `turn.audio.done`, cancellation, and drain behavior through the playback port. Do not assert on implementation timers or adapter internals.
