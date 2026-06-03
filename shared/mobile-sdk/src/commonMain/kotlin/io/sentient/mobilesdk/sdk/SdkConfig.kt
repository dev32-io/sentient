// ---------------------------------------------------------------------------
// SdkConfig — immutable orchestrator configuration.
//
// Mirrors web-sdk's SentientSDKConfig (connector-types.ts): the gateway URL,
// the dev-only self-signed bypass, the capability set advertised in
// session.configure, and the reconnect tunables. Defaults live here, not in
// code branches, per .claude/rules/config.md.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audio.EchoGateConfig
import io.sentient.mobilesdk.audio.SpeechGateConfig
import io.sentient.mobilesdk.transport.ReconnectConfig

// ---------------------------------------------------------------------------
// Audio pipeline tunables. The gateway ships these client-side (webui's
// constants.ts) rather than over session.ready, so the mobile-sdk mirrors the
// same tuned values as injected defaults. THESE ARE OPERATOR-TUNED CONSTANTS —
// do NOT change them; accept them via this config and forward to the gates.
// Values mirror gateway/webui/src/constants.ts (ECHO_GATE_* / SPEECH_GATE_*)
// and the gateway-negotiated STT input rate.
// ---------------------------------------------------------------------------

/** RMS [0,1] above which a mic frame is real speech when no TTS is active. */
private const val ECHO_BASELINE_THRESHOLD = 0.03
/** RMS [0,1] above which a mic frame is real speech while TTS plays / tails. */
private const val ECHO_PLAYBACK_THRESHOLD = 0.2
/** Ms to hold the elevated threshold after playback drains (DAC + speaker tail). */
private const val ECHO_TAIL_HOLD_MS = 800L

/** Sustained speech (ms) required to open the SpeechGate. */
private const val SPEECH_OPEN_DEBOUNCE_MS = 200
/** Non-speech frames tolerated before the sustain counter resets. */
private const val SPEECH_GAP_TOLERANCE_FRAMES = 3
/** Pre-roll frames retained so the onset flushes intact on open (≈240 ms). */
private const val SPEECH_PREROLL_FRAMES = 24
/** Failsafe: force-close the latch after this long if transcript.final never lands. */
private const val SPEECH_MAX_OPEN_MS = 20_000L

/** Gateway-negotiated STT input rate (Hz). Capture emits PCM16 LE at this rate. */
private const val DEFAULT_INPUT_SAMPLE_RATE = 16_000
/** Default assistant playback rate (Hz) until session.ready overrides it. */
private const val DEFAULT_OUTPUT_SAMPLE_RATE = 24_000
/** One mic frame duration (ms). Drives SpeechGate sustain math + RMS framing. */
private const val DEFAULT_FRAME_DURATION_MS = 20

/**
 * Audio voice-pipeline tunables (E3). All values are operator-tuned; the
 * orchestrator forwards them into the EchoGate / SpeechGate / capture rate. The
 * [echoGate] thresholds and [speechGate] debounce ARE the user-tuned constants
 * — never mutate them in code.
 *
 * @param echoGate EchoGate thresholds + tail hold (RMS echo suppression).
 * @param speechGate SpeechGate debounce + pre-roll (sustained-speech latch).
 * @param inputSampleRate Mic capture / STT uplink rate (Hz). session.ready may override.
 * @param outputSampleRate Assistant playback rate (Hz). session.ready may override.
 * @param frameDurationMs Duration of one captured frame (ms).
 */
data class AudioPipelineConfig(
    val echoGate: EchoGateConfig = EchoGateConfig(
        baselineThreshold = ECHO_BASELINE_THRESHOLD,
        playbackThreshold = ECHO_PLAYBACK_THRESHOLD,
        tailHoldMs = ECHO_TAIL_HOLD_MS,
    ),
    val speechGate: SpeechGateConfig = SpeechGateConfig(
        openDebounceMs = SPEECH_OPEN_DEBOUNCE_MS,
        frameDurationMs = DEFAULT_FRAME_DURATION_MS,
        gapToleranceFrames = SPEECH_GAP_TOLERANCE_FRAMES,
        preRollFrames = SPEECH_PREROLL_FRAMES,
        maxOpenMs = SPEECH_MAX_OPEN_MS,
    ),
    val inputSampleRate: Int = DEFAULT_INPUT_SAMPLE_RATE,
    val outputSampleRate: Int = DEFAULT_OUTPUT_SAMPLE_RATE,
    val frameDurationMs: Int = DEFAULT_FRAME_DURATION_MS,
)

/**
 * Configuration for [SentientSdk].
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws`. SessionResume
 *   appends `?session_id=` to this on connect when a stored pointer exists.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param capabilities Capability strings advertised in `session.configure`.
 *   Mirror the webui set; the orchestrator merges these with each connector's
 *   own `capability` so the gateway activates the right connectors.
 * @param reconnect Reconnect / backoff tunables (defaults mirror web-sdk).
 * @param audio Voice-pipeline tunables (E3): gate thresholds + sample rates.
 */
data class SdkConfig(
    val gatewayWsUrl: String,
    val allowSelfSignedDevHost: Boolean,
    val capabilities: List<String>,
    val reconnect: ReconnectConfig = ReconnectConfig(),
    val audio: AudioPipelineConfig = AudioPipelineConfig(),
)
