# Audio Cycle Serialization

The webui's `CycleAudioQueue` enforces single-cycle audio playback on the
client, with bounded preemption so short acknowledgments like "let me check
that for you" finish before a newer cycle's audio takes over.

## State

- `activeCycle: { id, startedAtMs, doneReceived } | null`
- `pending: { id, firstArrivedAtMs, queuedFrames, doneReceived } | null`
- `preemptTimer: Timer | null`

Only one cycle is active at a time. At most one cycle is pending. If a
newer cycle arrives while another is pending, the older pending is dropped
(`superseded-by-newer-cycle` WARN).

## Rule

Decision is made the moment the next cycle's **first audio chunk** arrives:

- `elapsed(active) >= minEagerEndMs` → immediate preempt: `fadeOutAndClear(preemptFadeoutMs)`, then promote pending.
- `elapsed(active) < minEagerEndMs` → schedule a preempt timer at `active.startedAtMs + minEagerEndMs`. If active drains naturally before the deadline, promote pending with zero gap and cancel the timer. If the deadline fires first, fade and preempt.
- Barge-in / Stop → `playback.clear()`, both queues wiped, no fade. Instant.

## Fade-on-preempt

The playback adapter (`FadeablePlaybackAdapter`) ramps its GainNode from
current gain to 0 over `preemptFadeoutMs` (default 30ms), then `clear()`s.
Avoids clicks when a cycle is cut mid-sample. Timing verified in
`web-audio-playback.test.ts`.

## Configuration

Server-authoritative via `session.ready.playback`:

```yaml
# gateway/config.yaml
webui:
  playback:
    min_eager_end_ms: 3000     # Range: 0-10000
    preempt_fadeout_ms: 30     # Range: 0-100
```

If `session.ready` omits the `playback` block (older gateway build), the
client falls back to `DEFAULT_MIN_EAGER_END_MS` / `DEFAULT_PREEMPT_FADEOUT_MS`
in `gateway/webui/src/constants.ts`.

## Implementation

- `gateway/webui/src/adapters/cycle-audio-queue.ts` — queue + preempt decision
- `gateway/webui/src/adapters/web-audio-playback.ts` — `FadeablePlaybackAdapter`
- `gateway/src/session-handlers/ws-session-configure.ts` — emits the playback block
- `shared/web-sdk/src/session-ready-handler.ts` — validates + routes to `onSessionReady`

## Non-goals

- This layer does **not** do per-sentence cut-in, crossfades, or multi-stream
  mixing. One cycle plays at a time. If design needs cross-cycle mixing, a
  different layer should sit above this queue.
- This layer does **not** detect natural sentence boundaries. "Let me
  check…" is protected by the min-eager-end cap, not by a VAD.
