# AwaitingTracker FSM

The tracker keeps Interrupt available from Send until audio starts or the turn ends. It bridges the gap between server cognition becoming idle and the first `turn.audio.start`; it is client presentation state, not a second runtime state store.

## States and transitions

The implementation has an implicit `disarmed`/`armed` boolean and one grace timer:

| Event | Result |
|---|---|
| `arm()` | armed; cancel any grace timer |
| `onCognitionActive()` | cancel grace timer; remain armed |
| `onCognitionIdle(true)` | no timer; audio visibility owns the active state |
| `onCognitionIdle(false)` | start the configured grace timer |
| grace timer | disarm |
| `onAudioStart()` | disarm |
| `onPlaybackEnded()` | disarm |
| `dispose()` | cancel timer |

`onChange` fires only when the armed value changes. `use-voice-client.ts` uses it to derive UI status; callers do not inspect private state. Duplicate arm calls are harmless and a pending grace timer is always cancelled before a new active signal.

Implementation and tests:

- `gateway/webui/src/hooks/awaiting-tracker.ts`
- `gateway/webui/src/hooks/awaiting-tracker.test.ts`

Keep the tracker focused on the Interrupt affordance. Turn truth comes from the SDK's `turn.*` events and playback truth comes from the audio adapter.
