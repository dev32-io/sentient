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

/**
 * Consecutive above-threshold 20 ms frames required before the OnsetDetector fires
 * the speech-onset edge (Task 9 uplink). Small by design — the onset is a barge-in
 * EDGE flag, not endpointing (the server owns VAD). Valid range ~1–4: 1 fires on the
 * first loud frame (twitchy), >4 adds latency to the local barge-in duck.
 */
private const val ONSET_SUSTAIN_FRAMES = 2

/**
 * Default window (ms) collapsing rapid new-chat taps into a single ACP mint.
 * The gateway's session.new pre-warm is deliberately slow; without a client-side
 * debounce a double-tap mints two phantom sessions. Valid range ~1000–5000ms:
 * below 1s a fast double-tap can still double-mint; above 5s a genuine "new chat
 * right after the last one" is swallowed.
 */
private const val DEFAULT_MINT_DEBOUNCE_MS = 3_000L

/**
 * Foreground liveness-probe timeout (ms). On returning to the foreground the SDK
 * sends ONE ping and waits this long for a pong before treating the (possibly
 * OS-frozen / half-open) socket as dead and reconnecting. One-shot per foreground
 * — there is no periodic heartbeat — so the battery cost is negligible. Valid
 * range ~1000–10000ms: too low false-reconnects on a slow network; too high
 * delays recovery after a genuine drop.
 */
private const val DEFAULT_FOREGROUND_PROBE_TIMEOUT_MS = 3_000L

/**
 * Client-side stuck-state safety-net timeout (ms). If cognition is THINKING or
 * audio is SPEAKING but no server frame advances or ends the cycle within this
 * window (e.g. the socket silently died while backgrounded), the SDK resets
 * cognition→IDLE / isSpeaking→false so Stop is never a dead end. Valid range
 * ~4000–15000ms. Default 8000.
 */
private const val DEFAULT_STUCK_STATE_TIMEOUT_MS = 8_000L

/** Gateway-negotiated STT input rate (Hz). Capture emits PCM16 LE at this rate. */
private const val DEFAULT_INPUT_SAMPLE_RATE = 16_000
/** Default assistant playback rate (Hz) until session.ready overrides it. */
private const val DEFAULT_OUTPUT_SAMPLE_RATE = 24_000
/** One mic frame duration (ms). Drives SpeechGate sustain math + RMS framing. */
private const val DEFAULT_FRAME_DURATION_MS = 20

/**
 * Settle (ms) after the playback adapter reports idle (speaker physically drained)
 * before the speaking state — and the interrupt affordance — clears. A small margin
 * so the very tail of a reply isn't clipped from the affordance. Valid ~0–1000ms.
 */
private const val DEFAULT_PLAYBACK_DRAIN_SETTLE_MS = 250L

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
 * @param onsetSustainFrames Consecutive loud frames before the uplink OnsetDetector
 *   fires the barge-in edge (Task 9). The RMS threshold it compares against reuses
 *   [echoGate]'s baselineThreshold — no separate tunable.
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
    val playbackDrainSettleMs: Long = DEFAULT_PLAYBACK_DRAIN_SETTLE_MS,
    val onsetSustainFrames: Int = ONSET_SUSTAIN_FRAMES,
)

/**
 * Configuration for [SentientSdk].
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws`. The SDK connects
 *   with this BASE url directly — no connect-URL session resume (A1); session
 *   continuity is re-established via a fire-and-forget session.switch on reconnect.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param capabilities Capability strings advertised in `session.configure`.
 *   Mirror the webui set; the orchestrator merges these with each connector's
 *   own `capability` so the gateway activates the right connectors.
 * @param reconnect Reconnect / backoff tunables (defaults mirror web-sdk).
 * @param audio Voice-pipeline tunables (E3): gate thresholds + sample rates.
 * @param mintDebounceMs Window (ms) collapsing rapid new-chat taps into a single
 *   ACP mint (A2). Default [DEFAULT_MINT_DEBOUNCE_MS]; valid range ~1000–5000ms.
 * @param foregroundProbeTimeoutMs Ms to await a pong after the one-shot foreground
 *   liveness ping before reconnecting. Default [DEFAULT_FOREGROUND_PROBE_TIMEOUT_MS].
 * @param stuckStateTimeoutMs Client-side safety-net: reset THINKING/SPEAKING to IDLE
 *   if no server frame advances or ends the cycle within this window. Valid range
 *   ~4000–15000ms. Default 8000.
 */
data class SdkConfig(
    val gatewayWsUrl: String,
    val allowSelfSignedDevHost: Boolean,
    val capabilities: List<String>,
    val reconnect: ReconnectConfig = ReconnectConfig(),
    val audio: AudioPipelineConfig = AudioPipelineConfig(),
    val mintDebounceMs: Long = DEFAULT_MINT_DEBOUNCE_MS,
    val foregroundProbeTimeoutMs: Long = DEFAULT_FOREGROUND_PROBE_TIMEOUT_MS,
    val stuckStateTimeoutMs: Long = DEFAULT_STUCK_STATE_TIMEOUT_MS,
    // Debug-only: enables FaultHooks injection for E2E. MUST be false in release.
    val devFaultsEnabled: Boolean = false,
)
