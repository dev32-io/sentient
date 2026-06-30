// ---------------------------------------------------------------------------
// SdkVoice — builds + holds the real-time voice UPLINK pipeline (Task 9).
//
// Extracted from SentientSdk (mirrors SdkAudio) so the orchestrator stays lean.
// Owns the VoiceUplinkPipeline (mic → Framer → OnsetDetector → Opus → WS binary)
// plus the dedicated SERIAL dispatcher it runs on — OFF the orchestrator scope so
// the non-thread-safe Framer/encoder are never touched concurrently. The
// audioInput connector is supplied lazily (a () -> connector lambda) to break the
// construction cycle, exactly as SdkAudio does.
//
// When the platform bundle ships NO MicSource (text-only path / host tests), the
// pipeline is null: start()/stop() are no-ops and [micState] stays Idle — so
// startMic/stopMic still send audio.start/audio.end with no uplink, matching the
// pre-mic behavior.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audio.opus.LazyOpusEncoderPort
import io.sentient.mobilesdk.audio.opus.OpusUplinkEncoder
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.MicState
import io.sentient.mobilesdk.voice.VoiceUplinkPipeline
import io.sentient.mobilesdk.voice.io.MicSource
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Constructs and owns the voice-uplink pipeline (Task 9).
 *
 * @param mic Platform mic primitive; null on the text-only / test path.
 * @param audioConfig Tuned thresholds (operator config) — the OnsetDetector reuses
 *   echoGate.baselineThreshold + onsetSustainFrames.
 * @param audioInput Lazy accessor for the uplink connector (cycle-break).
 * @param scope Orchestrator scope the pipeline's collect job is launched from.
 */
class SdkVoice(
    mic: MicSource?,
    audioConfig: AudioPipelineConfig,
    audioInput: () -> UserAudioInputConnector,
    scope: CoroutineScope,
) {
    private val log = createLogger("sdk", "voice")

    /** Reactive mic-engine state for the UI (Idle until/unless a real mic is wired). */
    val micState: StateFlow<MicState> = mic?.state ?: MutableStateFlow(MicState.Idle)

    // Dedicated SERIAL dispatcher OFF the orchestrator scope: guarantees the
    // non-thread-safe Framer + Opus encoder are never accessed concurrently.
    // limitedParallelism(1) over Dispatchers.Default is commonMain-safe and needs
    // no close() (unlike newSingleThreadContext).
    private val uplinkDispatcher = Dispatchers.Default.limitedParallelism(1)

    // Null on the text-only path (no MicSource): start/stop become no-ops so the
    // wire still carries audio.start/audio.end with no uplink frames.
    private val pipeline: VoiceUplinkPipeline? = mic?.let { source ->
        VoiceUplinkPipeline(
            mic = source,
            // FRESH lazy uplink encoder for the voice path; native kopus only
            // allocates once a real frame encodes (on a device), so host-JVM tests
            // never load libopus.
            encoder = LazyOpusEncoderPort { OpusUplinkEncoder() },
            sendPacket = { packet -> audioInput().sendAudioFrame(packet) },
            // Slice 1 = onset FLAG only; barge-in commit (cycleId) is a later slice.
            onOnset = { log.debug("onset") },
            scope = scope,
            dispatcher = uplinkDispatcher,
            framer = Framer(),
            onset = OnsetDetector(
                threshold = audioConfig.echoGate.baselineThreshold,
                sustainFrames = audioConfig.onsetSustainFrames,
            ),
        )
    }

    /** Start the uplink — the pipeline drives the MicSource off the orchestrator. */
    suspend fun start() {
        log.info("startUplink", mapOf("wired" to (pipeline != null)))
        pipeline?.start()
    }

    /** Stop the uplink — cancelAndJoin the collect, reset encoder, release the mic. */
    suspend fun stop() {
        log.info("stopUplink")
        pipeline?.stop()
    }
}
