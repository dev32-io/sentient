# Voice Loop Fixtures

PCM16 LE mono 16 kHz raw audio for voice-loop testing.

## Files

- `speech-what-is-two-plus-two.pcm` — 2.62 s: 250 ms lead silence, a spoken
  "What is two plus two?", 1.20 s trailing silence. The trailing silence is not
  padding for its own sake — the STT service's turn-end detector (Silero VAD +
  Smart-Turn v3) needs it to close the turn.
  **Verified 2026-07-30** against the live native whisper-stt at `ws://127.0.0.1:8768`:
  ```
  READY: ready
  transcript_ready {"turnIdx": 1, "text": "What is 2 plus 2?", "decodeMs": 439.751, "audioSeconds": 1.696}
  ```
- `silence-500ms.pcm` — 500 ms of silence. Exercises byte plumbing only; STT
  correctly returns no transcript (below the VAD threshold).

## STATUS 2026-07-30 (native-stack migration, Task 10) — READ THIS FIRST

**The on-device fixture-injection channel these fixtures were written for no longer
exists.** It was removed by the mobile voice refactor (the `VoiceAudio`
consolidation), not by the native-stack migration:

- `shared/mobile-sdk/.../dev/FaultHooks.kt` now exposes **only**
  `armExpiredToken()` and `armMalformedFrame()`. There is no
  `loadFixtureUtterance`, and `grep -rn "FaultAwareCaptureAdapter\|loadFixture"`
  over `android/src` + `shared/mobile-sdk/src` returns **nothing**.
- `android/src/debug/.../DebugFaultReceiver.kt` handles `kind=expired` and
  `kind=malformed`; anything else falls into
  `else -> log.warn("fault.broadcast.unknown-kind")`. So
  `am broadcast … --es kind fixture` reports `result=0` (delivered) and is then
  **silently discarded** — the mic keeps capturing from the emulator's real
  (silent) input device.

Consequence: the old recipe cannot work, and any flow or runner phase that greps
for `fixture-utterance` is asserting on a log line no code can emit.
`08-voice-loop.yaml` and `run-e2e.sh`'s `push_and_arm_fixture` are annotated
accordingly rather than deleted — the capability should come back, and these
fixtures are the half of it that is ready and proven.

**Second, independent blocker on the same row:** the Android mic control is
**hold-to-talk**, not a toggle. A Maestro `tapOn: chat-mic` produces
`pressMic` → `releaseMic` ~147 ms apart (measured), capturing exactly one
320-sample frame:
```
sdk.orchestrator: pressMic
voice.talk-mode: talk-mode from=Idle to=Hold trigger=pressMic
voice.engine.android: record-started source=6 frameSamples=320
sdk.orchestrator: releaseMic                     <-- 147 ms later
voice.engine.android: record-stop captured=1 dropped=0
```
Gateway side: `stt.audio-start` … `stt.audio-end` 180 ms apart, no transcript.
A flow that only taps the mic cannot produce a turn even once injection returns.

## Full STT→LLM→TTS loop — what it needs

1. Re-introduce a fixture (or loopback) capture source in the SDK's voice engine
   plus a `kind=fixture` arm in `DebugFaultReceiver`: a debug-only capture
   adapter that yields fixture bytes instead of the device mic.
2. Hold the mic for the fixture's real duration (Maestro `longPressOn`, or a
   debug affordance that latches the mic) — not a tap.
3. Then expect: `stt.transcript.submit` → `runtime:react-loop react-loop.start`
   → `turn.text.delta`* → `turn.completed` → `turn-voice.audio.*`.

Worth knowing: the STT path calls `runtime.submit()` **server-side**
(`gateway/src/session-handlers/stt-session.ts:119`), so it does not pass through
the client outbox. That matters because the *text* path is currently blocked by
defect D12 (the gateway never answers `session.new`, so the outbox never drains —
`qa/mobile/evidence/2026-07-30-native-mobile-matrix/README.md`) while the voice
path would not be.

Until (1) and (2) exist, `voice-roundtrip` on native is a real-device case:
simulators and emulators have no usable audio path, which is what the
`physical-only` tag is for.

## Regenerating / adding a speech fixture (macOS, no third-party tools)

```bash
say -v Samantha -r 165 -o say.aiff "What is two plus two?"
afconvert -f WAVE -d LEI16@16000 -c 1 say.aiff say16k.wav
python3 - <<'PY'
import wave
w = wave.open('say16k.wav','rb')            # expect: 1 ch / 16000 Hz / 16-bit
data = w.readframes(w.getnframes())
lead = b'\x00\x00' * int(16000 * 0.25)
tail = b'\x00\x00' * int(16000 * 1.20)      # the turn-end detector needs this
open('speech-<phrase>.pcm','wb').write(lead + data + tail)
PY
```

Validate at the service seam before spending a device run on it — this is the
probe that produced the transcript quoted above: connect the whisper-stt venv
python to `ws://127.0.0.1:8768?language=auto&audioFormat=pcm16`, wait for the
`ready` frame, send 640-byte (320-sample) chunks every 20 ms, then read frames
until `transcript_ready`.
