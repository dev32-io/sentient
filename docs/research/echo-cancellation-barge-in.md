# Echo Cancellation & Barge-In Research

**Date:** 2026-04-08
**Context:** TTS playback picked up by mic causes false barge-in (self-interruption)

## Problem

When the assistant speaks through the speaker, the microphone picks up the TTS audio.
Deepgram's VAD detects it as human speech (`speech_started` event), and Deepgram may
even transcribe it as words like "Okay" or "What?". This causes:
1. False barge-in — assistant cuts itself off
2. Phantom transcripts — Deepgram hallucinates words from TTS audio
3. Echo feedback loop — system responds to its own output

## Why Browser echoCancellation Doesn't Work

The browser's built-in AEC (`echoCancellation: true` on getUserMedia) only cancels audio
from **WebRTC peer connections** (remote participant audio). Our TTS plays through a local
`AudioContext` — the browser AEC doesn't know this audio exists, so it can't subtract it
from the mic input.

## Industry Solutions

### 1. WebRTC Loopback Trick (Web) — RECOMMENDED

Route TTS audio through a local `RTCPeerConnection` loopback instead of playing directly
through AudioContext. The browser treats it as "remote participant audio" and its built-in
AEC automatically subtracts it from the microphone capture.

- Demo: https://cv.nguyenbinh.dev/browser-aec/
- No external libraries — pure Web APIs
- Used by production voice assistants
- Also works in Electron (Chromium-based)

### 2. Android Native AEC

Android provides `AcousticEchoCanceler` API linked to `AudioRecord` sessions.
Use `MediaRecorder.AudioSource.VOICE_COMMUNICATION` to activate hardware AEC.
The OS handles echo subtraction when it knows which audio session is the playback reference.

- API: https://developer.android.com/reference/android/media/audiofx/AcousticEchoCanceler
- Hardware AEC quality varies by device; software AEC (WebRTC) as fallback

### 3. iOS Native AEC

`AVAudioSession` mode `.voiceChat` with `VoiceProcessingIO` audio unit provides
Apple's built-in echo cancellation, noise suppression, and AGC — best-in-class.

- Supports up to 48KHz
- WWDC23: https://developer.apple.com/videos/play/wwdc2023/10235/
- Just set the audio session mode; Apple handles everything

### 4. LiveKit / Krisp (Commercial)

LiveKit Cloud uses licensed Krisp models for enhanced noise + echo cancellation,
including a background voice cancellation (BVC) model. Proprietary, requires LiveKit Cloud.

- Docs: https://docs.livekit.io/transport/media/noise-cancellation/

### 5. Server-Side AEC

Send both mic audio and TTS reference signal to the server, subtract server-side before
feeding to Deepgram. Doubles bandwidth, more complex, higher latency.

## What ChatGPT Voice Mode Does

OpenAI's Advanced Voice Mode has the same problem. Their official recommendation is to
use headphones. Users report frequent false interruptions. OpenAI suggests iOS Voice
Isolation mic mode as a workaround.

- Forum: https://community.openai.com/t/feature-request-advanced-voice-mode-keeps-interrupting-me/962909

## Architecture: SDK Black Box

Each platform SDK provides an `AudioPlaybackAdapter` with AEC built in:

| Platform | Implementation | AEC Source |
|----------|---------------|-----------|
| Web | WebRTC loopback | Browser AEC (Chromium/Firefox) |
| Android | VOICE_COMMUNICATION + AcousticEchoCanceler | Hardware/OS AEC |
| iOS | AVAudioSession voiceChat + VoiceProcessingIO | Apple AEC |
| Desktop | Same as web (Electron = Chromium) | Browser AEC |

The developer never sees AEC. The pipeline, TurnController, barge-in logic — all unchanged.
Each platform SDK provides the right AudioPlaybackAdapter internally.

## Current Workarounds (Until AEC Is Implemented)

1. **Echo cooldown (1500ms):** Suppress transcripts briefly after assistant stops speaking
2. **Confidence gate (≥ 0.9):** Only trigger barge-in on high-confidence finalized transcripts
3. **Silero VAD:** ML-based speech classifier filters obvious non-speech noise
4. **Headphones:** Eliminates the problem entirely (recommended for now)

## Next Steps

1. Implement WebRTC loopback playback adapter for web (replace AudioContext approach)
2. Test barge-in with loopback AEC — should eliminate false positives
3. Remove echo cooldown and speechStart-during-playback hacks
4. Implement native AEC adapters for Android/iOS when those SDKs begin
