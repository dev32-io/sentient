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
// SERIALIZATION (toggle-race fix): mic start/stop are NOT launched as two
// independent coroutines. They are submitted as ordered [Cmd]s onto a single
// UNLIMITED command channel drained by ONE consumer coroutine. The consumer runs
// each command to completion (engine up + collect job assigned for Start; job
// cancelled + mic released for Stop) BEFORE pulling the next — so a rapid
// start→stop (or Error-recovery stop→start) can never interleave, and Start's
// suspending mic.start() can never leave the mic live after a Stop. This is the
// only correct fix: a bare Mutex would let two independent launches acquire the
// lock out of submission order; a single FIFO consumer preserves exact order.
//
// Control frames (audio.start / audio.end) ride the SAME lane: the consumer emits
// audio.start BEFORE pipeline.start and audio.end AFTER pipeline.stop, so the wire
// order audio.start → binary frames → audio.end is preserved and serialized too.
//
// When the platform bundle ships NO MicSource (text-only path / host tests), the
// pipeline is null: Start/Stop only fire the control-frame callbacks and [micState]
// stays Idle — so startMic/stopMic still send audio.start/audio.end with no uplink,
// matching the pre-mic behavior.
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
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * Constructs and owns the voice-uplink pipeline (Task 9), serializing mic start/stop
 * through a single ordered command consumer (kills the start→stop toggle race).
 *
 * @param mic Platform mic primitive; null on the text-only / test path.
 * @param audioConfig Tuned thresholds (operator config) — the OnsetDetector reuses
 *   echoGate.baselineThreshold + onsetSustainFrames.
 * @param audioInput Lazy accessor for the uplink connector (cycle-break, frame sink).
 * @param onUplinkStart Control-frame sender run BEFORE pipeline.start (audio.start).
 *   Lazy/cycle-safe — only deref the connector when invoked, same as [audioInput].
 * @param onUplinkStop Control-frame sender run AFTER pipeline.stop (audio.end).
 * @param scope Orchestrator scope: the pipeline's collect job AND the single command
 *   consumer are launched from it, so terminal teardown is scope-cancel.
 */
class SdkVoice(
    mic: MicSource?,
    audioConfig: AudioPipelineConfig,
    audioInput: () -> UserAudioInputConnector,
    private val onUplinkStart: () -> Unit,
    private val onUplinkStop: () -> Unit,
    scope: CoroutineScope,
    // Dedicated SERIAL dispatcher OFF the orchestrator scope: guarantees the
    // non-thread-safe Framer + Opus encoder are never accessed concurrently.
    // limitedParallelism(1) over Dispatchers.Default is commonMain-safe and needs
    // no close() (unlike newSingleThreadContext). Injectable ONLY so commonTest can
    // pin the pipeline's collect job to the test scheduler for a deterministic join;
    // production uses the default and is unchanged.
    uplinkDispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
) {
    private val log = createLogger("sdk", "voice")

    /** Reactive mic-engine state for the UI (Idle until/unless a real mic is wired). */
    val micState: StateFlow<MicState> = mic?.state ?: MutableStateFlow(MicState.Idle)

    // Null on the text-only path (no MicSource): Start/Stop only fire the control
    // callbacks so the wire still carries audio.start/audio.end with no uplink frames.
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

    /** One ordered mic command. Start/Stop are drained FIFO by the single consumer. */
    private sealed interface Cmd {
        data object Start : Cmd
        data object Stop : Cmd
    }

    // UNLIMITED (never CONFLATED): every toggle is preserved FIFO. A CONFLATED
    // channel could silently drop a queued Stop and leave the mic live after a
    // rapid start→stop → exactly the bug this class exists to kill.
    private val commands = Channel<Cmd>(Channel.UNLIMITED)

    init {
        // ONE consumer on the orchestrator scope: pulls commands sequentially, so
        // Start fully completes (engine up, collect job assigned) before Stop runs
        // — serial + ordered, satisfying the MicSource crash-safety contract.
        scope.launch { for (cmd in commands) handle(cmd) }
    }

    /** Enqueue a mic-start. Non-suspend; runs FIFO on the single consumer. */
    fun requestStart() {
        log.info("requestStart", mapOf("wired" to (pipeline != null)))
        commands.trySend(Cmd.Start)
    }

    /** Enqueue a mic-stop. Non-suspend; runs FIFO on the single consumer. */
    fun requestStop() {
        log.info("requestStop")
        commands.trySend(Cmd.Stop)
    }

    // Runs on the single consumer coroutine. Start = audio.start THEN pipeline.start;
    // Stop = pipeline.stop THEN audio.end. runCatching keeps one failed command from
    // killing the consumer; cancellation still propagates so scope teardown works.
    private suspend fun handle(cmd: Cmd) {
        runCatching {
            when (cmd) {
                Cmd.Start -> { onUplinkStart(); pipeline?.start() }
                Cmd.Stop -> { pipeline?.stop(); onUplinkStop() }
            }
        }.onFailure { err ->
            if (err is CancellationException) throw err
            log.warn("command-failed", mapOf("cmd" to (cmd::class.simpleName ?: "?"), "error" to (err.message ?: "unknown")))
        }
    }
}
