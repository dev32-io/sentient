# Voice Loop Fixtures

PCM16 LE mono 16kHz raw audio files for E2E voice-loop injection.

## Files

- `silence-500ms.pcm` — 500ms of silence at 16kHz PCM16. Tests the fixture-injection
  plumbing but produces no STT transcript (silence is below VAD threshold).

## Full STT→LLM→TTS Loop

To exercise a full voice cycle end-to-end:
1. Record a real utterance (e.g., "what is two plus two") as PCM16 LE mono 16kHz.
2. Save it here as e.g. `hello.pcm`.
3. Push to device: `adb push qa/mobile/fixtures/hello.pcm /sdcard/sentient-fixture.pcm`
4. Arm via broadcast: `adb shell am broadcast -a io.sentient.debug.FAULT --es kind fixture --es path /sdcard/sentient-fixture.pcm`
5. Tap mic; the fixture feeds through the uplink; STT processes it; Hermes replies; TTS plays back.

## Generating a Fixture with sox (on macOS)

```bash
# Record 3s silence (placeholder):
sox -n -r 16000 -c 1 -e signed -b 16 silence-500ms.pcm trim 0 0.5

# Record from microphone (requires sox + audio hardware):
sox -t coreaudio 'MacBook Pro Microphone' -r 16000 -c 1 -e signed -b 16 hello.pcm trim 0 3
```

## AUDIO LOOP STATUS (2026-06-06)

- **Fixture plumbing**: WIRED — `FaultAwareCaptureAdapter` wraps the real capture adapter
  and intercepts `frames()` to emit fixture bytes first.
- **Arming**: WIRED — broadcast `kind=fixture path=<sdcard-path>` loads the fixture into
  `FaultHooks.loadFixtureUtterance(pcm)`.
- **Full STT→LLM→TTS**: REQUIRES a real speech PCM fixture (not silence). The silence
  fixture tests plumbing only (fixture bytes flow through the Opus encoder → WS uplink →
  STT returns no transcript → no Hermes cycle triggered).
- **Physical mic on emulator**: The emulator mic may work if the host has a microphone
  and audio routing is set up. The fixture path bypasses this constraint.
- **FLAG**: A live recording fixture (`hello.pcm`) is the follow-up needed to complete the
  full audio E2E loop.
