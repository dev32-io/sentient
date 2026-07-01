// ---------------------------------------------------------------------------
// SdkVoice — builds + holds the real-time voice UPLINK pipeline (Task 9).
//
// Extracted from SentientSdk (mirrors SdkAudio) so the orchestrator stays lean.
// Owns the VoiceUplinkPipeline (micFrames → Framer → OnsetDetector → Opus → WS
// binary) plus the dedicated SERIAL dispatcher it runs on — OFF the orchestrator
// scope so the non-thread-safe Framer/encoder are never touched concurrently. The
// audioInput connector is supplied lazily (a () -> connector lambda) to break the
// construction cycle, exactly as SdkAudio does.
//
// Mic activation + TTS reconfig are NOT owned by the pipeline — [VoiceAudio.configure]
// (driven by the configure lane below) is the only path that flips micActive /
// playbackActive. The pipeline's collect job simply forwards what the engine emits,
// so it is dormant until a caller drives configure(mic=true).
//
// SERIALIZATION (mic+TTS reconfig never race): every reconfig is submitted as an
// ordered [Cmd.Configure] onto a single UNLIMITED command channel drained by ONE
// consumer coroutine. The consumer runs each command to completion BEFORE pulling
// the next — so a rapid mic-on→mic-off (or a TTS toggle mid-mic) can never
// interleave. This is the only correct fix: a bare Mutex would let two independent
// callers acquire the lock out of submission order; a single FIFO consumer
// preserves exact order.
//
// The consumer diffs each [Cmd.Configure] against the last-applied (mic, playback)
// and collapses identical configures (idempotent) — so a 5×(true) hammer records
// exactly one configure + one audio.start. Control frames (audio.start / audio.end)
// ride the SAME lane: the consumer emits audio.start BEFORE [voiceAudio.configure]
// + [pipeline.start] and audio.end AFTER [pipeline.stop] + configure settled, so
// the wire order audio.start → binary frames → audio.end is preserved and
// serialized too (no late frame past audio.end).
//
// When the platform bundle ships NO VoiceAudio (text-only path / host tests), the
// pipeline is null: Configure still fires the control-frame callbacks and [audioState]
// stays Idle — so startMic/stopMic still send audio.start/audio.end with no uplink,
// matching the pre-mic behavior.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audio.opus.LazyOpusEncoderPort
import io.sentient.mobilesdk.audio.opus.OpusUplinkEncoder
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.VoiceUplinkPipeline
import io.sentient.mobilesdk.voice.io.VoiceAudio
import io.sentient.mobilesdk.voice.io.VoiceAudioState
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.CompletableDeferred
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
 * @param voiceAudio Platform audio engine; null on the text-only / test path. The
 *   pipeline is built from [VoiceAudio.micFrames], which is hot ONLY while micActive.
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
    private val voiceAudio: VoiceAudio?,
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

    /** Reactive engine state for the UI (Idle unless a real VoiceAudio is wired). */
    val audioState: StateFlow<VoiceAudioState> =
        voiceAudio?.state
            ?: MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))

    // Null on the text-only path (no VoiceAudio): Start/Stop only fire the control
    // callbacks so the wire still carries audio.start/audio.end with no uplink frames.
    private val pipeline: VoiceUplinkPipeline? = voiceAudio?.let { va ->
        VoiceUplinkPipeline(
            micFrames = va.micFrames,
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

    /** One ordered configure command. Drained FIFO by the single consumer — the
     *  only path that touches VoiceAudio.configure + the uplink collect + the
     *  audio.start/audio.end control frames, so mic + TTS reconfigs NEVER race.
     *  [ack] (when non-null) is completed AFTER this exact command settles, carrying
     *  whether the engine reached playback-active Ready — so the downlink lazy-arm can
     *  await THIS command's result without racing a stale state-flow value. */
    private sealed interface Cmd {
        data class Configure(
            val mic: Boolean,
            val playback: Boolean,
            val ack: CompletableDeferred<Boolean>? = null,
        ) : Cmd
    }

    // UNLIMITED (never CONFLATED): every toggle is preserved FIFO. A CONFLATED
    // channel could silently drop a queued Stop and leave the mic live after a
    // rapid start→stop → exactly the bug this class exists to kill.
    private val commands = Channel<Cmd>(Channel.UNLIMITED)

    // Last-applied (mic, playback); the consumer diffs against this so consecutive
    // identical configures are a no-op (idempotent) — collapse the 5×(true) hammer.
    private var micOn = false
    private var playbackOn = false

    init {
        // ONE consumer on the orchestrator scope: pulls commands sequentially, so a
        // Configure fully completes (engine reconfigured, collect job started or
        // stopped, control frames sent) before the next runs — serial + ordered.
        scope.launch { for (cmd in commands) handle(cmd) }
    }

    /** THE serialized reconfig entry. Non-suspend; runs FIFO on the single consumer. */
    fun requestConfigure(mic: Boolean, playback: Boolean) {
        log.info("requestConfigure", mapOf("mic" to mic, "playback" to playback))
        commands.trySend(Cmd.Configure(mic, playback))
    }

    /** Convenience for startMic (mic axis only; keeps current playback). */
    fun requestStart() = requestConfigure(mic = true, playback = playbackOn)

    /** Convenience for stopMic (mic axis only; keeps current playback). */
    fun requestStop() = requestConfigure(mic = false, playback = playbackOn)

    /**
     * Playback axis only (keeps the current mic axis) — the disarm entry the downlink
     * pipeline drives on drain/interrupt (enabled=false). Enqueues on the SAME serialized
     * lane as mic, so it composes with VPIO. Disarming while mic is on is a mic-only cell
     * (engine stays up, no per-reply churn); disarming while mic is off tears the engine
     * to idle (battery). Fire-and-forget — no ack needed for a release.
     */
    fun requestPlayback(enabled: Boolean) = requestConfigure(mic = micOn, playback = enabled)

    /**
     * LAZY-ARM the playback axis and suspend until THIS reconfig settles. Enqueues a
     * Configure(mic=micOn, playback=true) carrying a completion ack, so the caller learns
     * the result of exactly this command — never a stale state-flow value from a prior
     * reconfig. Returns true iff the engine reached playback-active Ready. Null engine
     * (text/test path) → true (frames drop at the pipeline's null-playback guard).
     * The downlink pipeline awaits this on audio.start before flushing buffered frames.
     */
    suspend fun armPlayback(): Boolean {
        if (voiceAudio == null) return true
        val ack = CompletableDeferred<Boolean>()
        commands.trySend(Cmd.Configure(mic = micOn, playback = true, ack = ack))
        return ack.await()
    }

    // Runs on the single consumer coroutine. Idempotent: a configure that matches
    // the last-applied (mic, playback) collapses to a no-op (no engine call, no
    // audio edge) so the 5×(true) hammer records exactly one configure + one start.
    // Edge ordering: mic false→true → onUplinkStart → configure → pipeline.start
    // (audio.start before frames); mic true→false → pipeline.stop → configure →
    // onUplinkStop (audio.end after uplink down + configure settled — no late frame).
    private suspend fun handle(cmd: Cmd) {
        val c = cmd as Cmd.Configure
        if (c.mic == micOn && c.playback == playbackOn) {
            // Idempotent collapse: the engine is genuinely in (mic, playback) — micOn/
            // playbackOn only advance on a Ready configure — so an arm ack resolves to
            // whether playback is on (no re-configure needed; the player is already armed).
            c.ack?.complete(c.playback)
            return
        }
        runCatching {
            val micRising = c.mic && !micOn
            val micFalling = !c.mic && micOn
            // audio.start BEFORE the engine + uplink come up (wire order: start→frames→end).
            if (micRising) onUplinkStart()
            // Stop the uplink collect when mic goes away (before configure tears the tap).
            if (micFalling) pipeline?.stop()
            // THE single engine reconfig — VPIO flips iff the (mic,playback) cell changes.
            voiceAudio?.configure(c.mic, c.playback)
            // configure never throws (failures become Phase.Error inside), so runCatching
            // completes normally even on a failure. On Phase.Error the actual reset the
            // engine graph to idle (failReset/failConfigure) — so RECONCILE the lane to
            // the same idle baseline (micOn=playbackOn=false), NOT the requested values.
            // Keeping the requested values would let a later arm(playback=true) collapse
            // as "already armed" against a torn-down engine → silent dropped TTS. Idle
            // baseline means any non-idle retry differs → re-attempts (M1's goal).
            val phase = voiceAudio?.state?.value?.phase
            if (phase == Phase.Error) {
                log.warn("configure-error-reset-lane", mapOf("mic" to c.mic, "playback" to c.playback, "reason" to (voiceAudio?.state?.value?.errorReason ?: "unknown")))
                micOn = false; playbackOn = false
                c.ack?.complete(false)
                return@runCatching
            }
            // Start the uplink collect once the mic tap is live.
            if (micRising) pipeline?.start()
            micOn = c.mic; playbackOn = c.playback
            // audio.end AFTER the uplink is down + configure settled (no late frame past end).
            if (micFalling) onUplinkStop()
            c.ack?.complete(c.playback)
        }.onFailure { err ->
            if (err is CancellationException) { c.ack?.complete(false); throw err }
            log.warn("command-failed", mapOf("cmd" to "Configure", "error" to (err.message ?: "unknown")))
            c.ack?.complete(false)
        }
    }
}
