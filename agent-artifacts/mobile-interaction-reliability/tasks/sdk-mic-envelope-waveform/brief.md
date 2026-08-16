# Task Brief: Drive the existing mobile waveform from the SDK mic envelope

## Contribution Goal

The SDK converts the exact existing uplink signal into a rolling 32-level, 1.6-second envelope and both native waveform components render it without receiving PCM, owning a second tap, or changing visual design.

## Boundary — Included

- CommonMain MicLevelMeter and MicLevelEnvelope contract
- Android and iOS existing-capture feed points with no second microphone path
- VoiceAudio → SentientSdk → ChatComponent → native ViewModel/UI read-only signal
- Existing Android/iOS waveform adaptation and deterministic tests

## Required Work

- 1. Add MicLevelEnvelope with active plus exactly 32 normalized Float values and no PCM, timestamps, platform buffers, or retained audio. Add a commonMain MicLevelMeter that owns all mutable metering state.
- 2. Feed MicLevelMeter the post-conversion, post-resample, post-gain 16 kHz PCM already sent to uplink. Accumulate by sample count into 800-sample/50 ms windows so callback boundaries do not change timing.
- 3. For each complete window compute RMS, map it logarithmically into 0...1 using shared floor/ceiling constants, apply fast attack and modest release smoothing, and shift one value into the fixed 32-value ring. Initialize/fill missing history with the established silence baseline and reset on capture stop.
- 4. Integrate the meter into Android VoiceAudioRecord and both iOS MicCaptureEngine and DuplexEngine paths without installing another tap, creating another AudioRecord/engine, delaying frame delivery, or making meter failure affect uplink.
- 5. Expose micLevels as a conflated read-only StateFlow through VoiceAudio, SentientSdk, and ChatComponent. Keep micFrames on the internal SDK/uplink path and ensure native-facing state contains no audio arrays or platform types.
- 6. Thread the envelope through Android/iOS ChatViewModels and Composer into PttWave/PttBigWave. Map one recent value to each existing bar and preserve the current 32 bars, sine contour influence, full-composer placement, spacing, colors, silence baseline, transition character, and reduced-motion behavior. Remove autonomous fake pulsing as the primary driver; do not redesign the component.
- 7. Add common tests for exact 50 ms framing across partial/oversized callbacks, 32 values/1.6 seconds, logarithmic bounds, attack/release, silence, a 250–500 ms brief utterance spanning multiple bars, sustained input, invalid values, reset, and StateFlow conflation.
- 8. Add VoiceAudio/ChatComponent boundary tests proving the envelope advances from existing capture frames while PCM never crosses the UI-facing interface. Add native rendering/state tests using injected envelopes; do not attempt physical-mic E2E.
- 9. Use only sanitized aggregate diagnostics if needed and never log level history, PCM, audio, or user content.
- 10. Run shared SDK/data, Android, iOS, and diff checks.

## Integration Expectation

Deliver this contribution for integration in stage live-waveform.

## Context

- VoiceAudio currently exposes 16 kHz PCM micFrames for uplink but no visualization state. Android VoiceAudioRecord and iOS MicCaptureEngine/DuplexEngine already produce the required post-conversion/post-gain signal.
- Android PttWave and iOS PttBigWave are decorative 32-bar autonomous animations. Their bars, contour, placement, spacing, colors, baseline, and accessibility treatment are the approved design to preserve.
- Shared TalkMode is integrated by the predecessor and remains the authoritative active/visibility state. Native UI is a pure envelope consumer.
- Fixed audio-duration framing is required because platform capture callback sizes/rates differ.

## Boundary — Excluded

- A second mic tap or UI-owned capture engine
- Passing ShortArray/ByteArray/platform buffers into native ViewModels/UI
- A waveform redesign or assistant-playback visualization
- Physical microphone, acoustic, recognition, or user-assisted workflow testing
- Changing uplink encoding or STT behavior

## Interfaces and Dependencies

- Consumes the existing 16 kHz VoiceAudio capture frames and shared TalkMode visibility/lifecycle.
- Produces StateFlow<MicLevelEnvelope> through VoiceAudio, SentientSdk, and ChatComponent; native waveform views consume only its 32 values.
- Proof seam: deterministic PCM-to-envelope tests, no-PCM boundary tests, and injected native rendering tests.
