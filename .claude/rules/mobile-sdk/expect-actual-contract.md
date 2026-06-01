---
paths: ["shared/mobile-sdk/**"]
---
# expect/actual Contract

- Each platform capability is ONE `expect` (interface or class) in commonMain with exactly one `actual` per target.
- `actual` implementations own platform lifecycle (acquire/release); they NEVER contain business logic — they adapt platform → the commonMain interface and back.
- Keep `expect` surfaces minimal: data in, data out, callbacks for async. No platform types in the signature (use ByteArray/FloatArray/String/Flow, not AVAudioPCMBuffer/AudioRecord).
- Mirror web-sdk's adapter shapes: AudioCaptureAdapter, AudioPlaybackAdapter, SecureTokenStore, PushTokenProvider, LogSink, WebSocket engine.
- Every `actual` has a fake/in-memory commonTest double so commonMain logic tests run without a device.

> Details: agents/docs/mobile-sdk/expect-actual-contract-details.md
