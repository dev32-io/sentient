# interrupt — turn+TTS stop arm PASS; background-cancel arm BLOCKED

## Turn+TTS stop — PASS, driven twice live

**Recovery case (bonus):** clicked Interrupt while a phantom empty-text
turn's TTS was hung (see `../2026-07-30-steer-midloop/`) — cleanly
recovered it: `cancellation.no-turn-in-flight` (correct — the phantom
turn had already `turn.completed`) → `turn-voice.audio.cancel` →
`synthesize-aborted frameCount=0` → `ws-closed`. This also disproves my
own first-draft read of that defect as leaving the composer "permanently"
disabled — one Interrupt recovers it (see the steer-midloop README's
explicit correction).

**Clean case (primary evidence):** sent a ~150-word story prompt, waited
for `turn-emitter.audio-start` (text already `turn.completed` — audio is a
separate phase that starts after text settles, per the design), clicked
Interrupt while TTS was actively streaming:
```
cancellation.no-turn-in-flight | cutoff="interrupt" cancelBackground=true
turn-voice.audio.cancel | reason="user cancel gesture — barge-in or interrupt"
turn-emitter.playback-stop | turnId="4bf405f0…" reason="interrupt"
tts:streaming-tts-synthesizer synthesize-aborted | frameCount=24
tts:local-tts-socket ws-closed
```
24 real audio frames (359216 bytes) had already streamed; abort landed
within <1ms of the click and cleanly tore down the local-tts socket.
Screenshot: `desktop-audio-stop.png`.

## Background-cancel arm — BLOCKED (see delegate-hermes-bg README)

Cannot get a background task that's still running by the time a later
turn's reply is in flight — Hermes fails (with an error) in ~1-2s, always,
on this box (defects 1+2 in `../2026-07-30-delegate-hermes-bg/README.md`).
`background-registry.cancel-all | taskIds= count=0` in both drives above
confirms `cancelAll()` fires unconditionally on every Interrupt exactly as
designed (even with nothing to cancel) — the MECHANISM is proven wired
correctly, just never had a real task to prove it against. Re-run once
Hermes profile provisioning is fixed.

## `barge-in` row — the "UI arm" as specified does not exist in the current code

Traced `runtime.bargeIn()`'s only production caller:
`gateway/src/session-handlers/stt-session.ts:110` — real STT speech-onset
detection, nothing else. The webui's Stop/Interrupt button (confirmed
live, both drives above: `cutoff="interrupt"`) calls `runtime.interrupt()`
unconditionally — there is no client action that produces
`cutoff="barge-in"`. The migration task's own matrix row
("barge-in (UI arm only) | press Stop while TTS speaks | … cutoff:
'barge-in'") describes a control that isn't there: pressing Stop while TTS
speaks produces `cutoff="interrupt"` (proven above), never `"barge-in"`.
`cancellation.ts`'s own header comment is explicit that these are two
deliberately distinct gestures, not two triggers for the same outcome.
**Handing the entire barge-in case to Task 11** — not just the acoustic
sub-arm the task already flagged as agent-undrivable, but the full row,
since the "UI arm" premise doesn't hold. A real mic + real acoustic
speech-over-TTS is the only way to exercise `cutoff="barge-in"` at all.
