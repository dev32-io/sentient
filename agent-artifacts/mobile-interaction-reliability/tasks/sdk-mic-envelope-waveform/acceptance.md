# Task Acceptance: Drive the existing mobile waveform from the SDK mic envelope

## Deliverables

- The SDK converts the exact existing uplink signal into a rolling 32-level, 1.6-second envelope and both native waveform components render it without receiving PCM, owning a second tap, or changing visual design.

## Acceptance

- Every envelope contains exactly 32 bounded values representing 50 ms each and 1.6 seconds total
- Brief words remain visible across multiple recent bars; silence and sustained input produce stable expected shapes
- Android and both iOS capture paths meter the exact uplink signal without a second tap
- Native ViewModels/UI never receive PCM or platform audio objects
- The existing waveform design is preserved and is driven by real envelope data rather than autonomous placeholder animation
- Capture stop resets the envelope and meter failures cannot affect audio delivery
- No manual or physical-microphone acceptance step is introduced

## Boundary Proof

- Common MicLevelMeter tests cover framing, normalization, smoothing, history, brief input, and reset
- Boundary tests prove SDK containment and read-only envelope propagation
- Android and iOS rendering tests inject deterministic envelopes into the unchanged visual structure
