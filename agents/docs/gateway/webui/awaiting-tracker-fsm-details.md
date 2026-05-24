# AwaitingTracker FSM

Bridges the cognition-idle → audio-start gap so the Interrupt button stays
visible continuously from Send click through end of audio. Without the
tracker, the button would flicker off during the ~1-2 s window between
`cycle.completed` (server-side) and `onAudioStart` (first TTS frame at
the client).

## States

- **disarmed** (default) — `isAwaiting() === false`
- **armed** — user initiated a turn; Interrupt should be visible

## Transitions

| Event | Action |
|---|---|
| `arm()` (user clicks Send) | → armed (cancel any pending grace timer) |
| `onCognitionActive()` (cycle.started / ReAct continuation) | cancel grace timer; state unchanged |
| `onCognitionIdle(audioPlaying=true)` | no-op — audio-playing state owns visibility |
| `onCognitionIdle(audioPlaying=false)` | start grace timer (`AWAITING_GRACE_MS = 2 s`) |
| grace timer fires | → disarmed |
| `onAudioStart()` | → disarmed (audio took over) |
| `onPlaybackEnded()` (drain / stop / cancelled) | → disarmed |
| `dispose()` | cancel grace timer; state unchanged |

## Why a tracker instead of inline refs

Prior implementation used `awaitingResponseRef` + `awaitingGraceTimer` as
raw module-scope vars, mutated from five different connector callbacks.
Transitions were easy to miss (cancel-then-set; set-but-don't-cancel),
and the logic was untestable in isolation.

The tracker encapsulates:
- grace timer lifecycle (one place sets, one place clears)
- no-op check on duplicate `arm()`
- audio-playing gate that suppresses the grace timer

Fires a single `onChange` callback that drives `refreshStatus()` on the
hook side — the hook never reads internal state directly.

## Implementation

- `gateway/webui/src/hooks/awaiting-tracker.ts` — FSM
- `gateway/webui/src/hooks/awaiting-tracker.test.ts` — 11 cases (fake timers)
- `gateway/webui/src/hooks/use-voice-client.ts` — single construction site, transitions wired into connector callbacks
