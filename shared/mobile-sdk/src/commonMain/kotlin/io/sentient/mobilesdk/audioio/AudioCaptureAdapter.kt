// ---------------------------------------------------------------------------
// AudioCaptureAdapter — boundary interface for platform mic capture.
//
// Mirrors web-sdk's mic-capture adapter ROLE: the platform owns AudioRecord
// (Android) / AVAudioEngine (iOS) lifecycle and emits raw PCM16 LE frames; the
// commonMain pipeline (E3) consumes [frames] → SpeechGate → uplink. This is a
// commonMain INTERFACE only — no platform types in the signature (ByteArray /
// Flow / primitives), per .claude/rules/mobile-sdk/expect-actual-contract.md.
// The `actual` implementations land in E1 (androidMain/iosMain); a fake double
// lives in commonTest. Connectors and the E3 pipeline depend on this interface,
// never on a concrete capture impl.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import kotlinx.coroutines.flow.Flow

/**
 * Platform microphone capture. Emits PCM16 LE frames once started.
 *
 * Lifecycle is owned by the platform implementation: [start] acquires the mic,
 * [stop] releases it. [frames] is a cold stream that the pipeline collects while
 * capture is active. The capture sample rate is the gateway-negotiated input
 * rate (16000 Hz for STT).
 */
interface AudioCaptureAdapter {
    /** Emits PCM16 LE frames at [sampleRate] (16000) once started. */
    fun frames(sampleRate: Int): Flow<ByteArray>

    /** Acquire the mic and begin producing frames at [sampleRate]. */
    suspend fun start(sampleRate: Int)

    /** Release the mic and stop producing frames. Idempotent. */
    suspend fun stop()
}
