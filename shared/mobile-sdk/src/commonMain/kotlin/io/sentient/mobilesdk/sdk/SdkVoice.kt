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
// PATH + MIC-AXIS derivation are BOTH race-free against the back-to-back intents the
// TalkModeController fires (end+start on lock, stop+arm on release) — neither reads the
// tracked micOn, which lags behind those intents until each queued command APPLIES:
//   - the VoiceAudioPath for a turn-open is derived from the EXPLICIT turnMode (Manual →
//     Manual, Semantic/null → Duplex), never from a micOn-gated "rising edge" guess;
//   - the playback-axis-only commands (armPlayback / requestPlayback) carry NULL mic AND
//     NULL path sentinels, both resolved to the LIVE micOn / currentPath at APPLY time: an
//     arm enqueued behind a stop lands as (mic=false, …) — never re-opening the mic — and a
//     flush-arm enqueued behind a turn-open lands on the path that turn-open APPLIED (e.g.
//     Duplex on lock), never the stale pre-lock path that would degrade the whole session.
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
import io.sentient.mobilesdk.voice.io.VoiceAudioPath
import io.sentient.mobilesdk.voice.io.VoiceAudioState
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase
import io.sentient.mobilesdk.voice.talk.TurnMode
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
 * @param onUplinkStart Control-frame sender run BEFORE pipeline.start (audio.start). Carries
 *   the [TurnMode] for THIS mic-rising edge (design spec §4) — null ⇒ semantic (omitted on
 *   the wire). Lazy/cycle-safe — only deref the connector when invoked, same as [audioInput].
 * @param onUplinkStop Control-frame sender run AFTER pipeline.stop (audio.end).
 * @param scope Orchestrator scope: the pipeline's collect job AND the single command
 *   consumer are launched from it, so terminal teardown is scope-cancel.
 */
class SdkVoice(
    private val voiceAudio: VoiceAudio?,
    audioConfig: AudioPipelineConfig,
    audioInput: () -> UserAudioInputConnector,
    private val onUplinkStart: (TurnMode?) -> Unit,
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
            // Explicit mic axis, or NULL = "keep the LIVE micOn at apply time" — the
            // playback-axis-only sentinel used by armPlayback / requestPlayback. [handle]
            // resolves null to the tracked micOn AT APPLY TIME, so a playback command
            // enqueued behind a mic toggle applies against the already-advanced mic (it can
            // never re-open the mic or fire a spurious mic-rising audio.start).
            val mic: Boolean?,
            val playback: Boolean,
            // TurnMode for a mic-RISING edge only (audio.start). Ignored on playback-axis /
            // mic-falling configures. Null ⇒ semantic (omitted on the wire).
            val turnMode: TurnMode? = null,
            // VoiceAudioPath routing hint for the engine cell, or NULL = "keep the LIVE
            // currentPath at apply time" — the playback-axis-only sentinel (armPlayback /
            // requestPlayback), symmetric with the mic sentinel. Turn-opens carry an explicit
            // turnMode-derived path (see [derivePath]); turn-closes carry the tracked path.
            // [handle] resolves null to currentPath AT APPLY TIME, so a flush-arm enqueued
            // behind a turn-open lands on the APPLIED path, never the stale pre-lock path.
            val path: VoiceAudioPath? = null,
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

    // Last-applied VoiceAudioPath (mirrors micOn/playbackOn — updated only inside
    // [handle] once a Configure actually settles). Duplex is the idle baseline: today's
    // continuous/VPIO path, matching the pre-S3b default behavior.
    private var currentPath = VoiceAudioPath.Duplex

    init {
        // ONE consumer on the orchestrator scope: pulls commands sequentially, so a
        // Configure fully completes (engine reconfigured, collect job started or
        // stopped, control frames sent) before the next runs — serial + ordered.
        scope.launch { for (cmd in commands) handle(cmd) }
    }

    /** THE serialized reconfig entry. Non-suspend; runs FIFO on the single consumer. [turnMode]
     *  rides a mic-RISING edge only (audio.start); null ⇒ semantic. The VoiceAudioPath hint
     *  is derived via [derivePath] — see its KDoc for the mic-rising-vs-tracked distinction. */
    fun requestConfigure(mic: Boolean, playback: Boolean, turnMode: TurnMode? = null) {
        val path = derivePath(mic, turnMode)
        log.info(
            "requestConfigure",
            mapOf("mic" to mic, "playback" to playback, "turnMode" to (turnMode?.wireValue ?: "absent"), "path" to path.name),
        )
        commands.trySend(Cmd.Configure(mic, playback, turnMode, path))
    }

    /**
     * Derives the VoiceAudioPath for a Configure command. A turn-OPEN (mic requested true)
     * derives its path from the EXPLICIT [turnMode] — this is RACE-FREE: it never consults
     * the tracked [micOn], which lags behind the back-to-back intents the TalkModeController
     * fires (end+start on lock). [TurnMode.Manual] → [VoiceAudioPath.Manual] (hold /
     * MicCapture path); anything else, incl. null/Semantic → [VoiceAudioPath.Duplex]
     * (continuous / VPIO path). A turn-CLOSE (mic requested false) carries no turn-routing
     * intent, so it keeps the CURRENTLY TRACKED path — a Hold-release stop stays on the
     * Manual cell the Hold entry established.
     *
     * The playback-axis-only calls (armPlayback / requestPlayback) do NOT route through here:
     * they carry [currentPath] directly alongside the null mic sentinel.
     */
    private fun derivePath(mic: Boolean, turnMode: TurnMode?): VoiceAudioPath =
        if (mic) {
            if (turnMode == TurnMode.Manual) VoiceAudioPath.Manual else VoiceAudioPath.Duplex
        } else {
            currentPath
        }

    /**
     * TEST-ONLY seam: enqueues a Configure with an EXPLICIT [path], bypassing [derivePath].
     * Production callers MUST always go through [requestConfigure] / [requestStart] /
     * [requestPlayback] / [armPlayback] — [derivePath] is the single source of truth for path
     * derivation. This exists only because a same-cell path-flip ([path] differing from
     * [currentPath] while (mic, playback) stay put) is unreachable in any production flow (a
     * turn-open derives its path from turnMode and is always preceded by a mic-falling stop,
     * so `c.mic != micOn` at apply time there) but the idempotent-collapse guard in [handle]
     * still checks it defensively for a future path-aware caller (S4/S5) — this seam is how
     * commonTest pins that guard without waiting for that caller to exist.
     */
    internal fun requestConfigureWithPath(mic: Boolean, playback: Boolean, path: VoiceAudioPath) {
        commands.trySend(Cmd.Configure(mic, playback, path = path))
    }

    /** Convenience for startMic (mic axis only; keeps current playback). [turnMode] is carried
     *  on the audio.start emitted for the mic-rising edge — Manual (hold) / Semantic (continuous). */
    fun requestStart(turnMode: TurnMode? = null) = requestConfigure(mic = true, playback = playbackOn, turnMode = turnMode)

    /** Convenience for stopMic (mic axis only; keeps current playback). */
    fun requestStop() = requestConfigure(mic = false, playback = playbackOn)

    /**
     * Playback axis only (keeps the current mic axis) — the disarm entry the downlink
     * pipeline drives on drain/interrupt (enabled=false). Enqueues on the SAME serialized
     * lane as mic, so it composes with VPIO. Disarming while mic is on is a mic-only cell
     * (engine stays up, no per-reply churn); disarming while mic is off tears the engine
     * to idle (battery). Fire-and-forget — no ack needed for a release.
     *
     * BOTH axes are the NULL sentinel: [handle] resolves mic → the LIVE micOn and path →
     * the LIVE currentPath at apply time, so a disarm enqueued behind a mic toggle or a
     * turn-open can never re-open (or wrongly hold) the mic, nor pin the stale pre-toggle
     * path over the applied one. This call carries no turn-routing intent.
     */
    fun requestPlayback(enabled: Boolean) {
        log.info("requestPlayback", mapOf("enabled" to enabled))
        commands.trySend(Cmd.Configure(mic = null, playback = enabled, path = null))
    }

    /**
     * LAZY-ARM the playback axis and suspend until THIS reconfig settles. Enqueues a
     * playback-axis-only Configure carrying a completion ack, so the caller learns the result
     * of exactly this command — never a stale state-flow value from a prior reconfig. Returns
     * true iff the engine reached playback-active Ready. Null engine (text/test path) → true
     * (frames drop at the pipeline's null-playback guard). The downlink pipeline awaits this
     * on audio.start before flushing buffered frames.
     */
    suspend fun armPlayback(): Boolean {
        if (voiceAudio == null) return true
        val ack = CompletableDeferred<Boolean>()
        // Playback-axis-only: BOTH the mic AND the path are the NULL sentinel — "keep the LIVE
        // micOn / currentPath at apply time" (resolved in [handle]). The arm is enqueued BEHIND
        // the controller's preceding intents on the SAME lane, so resolving at apply time is
        // what makes it race-free against them:
        //   - Hold-RELEASE: behind requestStop's mic-falling command → by apply time micOn=false
        //     and currentPath=Manual → lands (mic=false, playback=true, Manual) → MediaPlayback,
        //     never re-opening the mic or emitting a spurious audio.start.
        //   - Hold-LOCK (buffered TTS): behind requestStart(Semantic) → by apply time
        //     currentPath=Duplex → lands (mic=true, playback=true, Duplex) → the VPIO cell, and
        //     leaves currentPath=Duplex. Snapshotting EITHER axis at SEND time (its prior form)
        //     captured the stale pre-lock value (still-true mic / Manual path) while the consumer
        //     was suspended inside the stop's pipeline.stop() cancelAndJoin.
        commands.trySend(Cmd.Configure(mic = null, playback = true, path = null, ack = ack))
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
        // Resolve the mic axis HERE, at apply time: an explicit value is used verbatim; the
        // NULL sentinel (playback-axis-only arm / disarm) reads the LIVE micOn now — so a
        // playback command enqueued behind a mic toggle applies against the already-advanced
        // mic and can never re-open it or emit a spurious mic-rising audio.start.
        val targetMic = c.mic ?: micOn
        // Resolve the path axis HERE too: an explicit value is used verbatim; the NULL sentinel
        // (playback-axis-only arm / disarm) reads the LIVE currentPath now — so a flush-arm
        // enqueued behind a turn-open lands on the path that turn-open APPLIED (e.g. Duplex on
        // lock), never the stale pre-lock path, and leaves currentPath on that applied value.
        val targetPath = c.path ?: currentPath
        if (targetMic == micOn && c.playback == playbackOn && targetPath == currentPath) {
            // Idempotent collapse: the engine is genuinely in (targetMic, playback, targetPath)
            // — micOn/playbackOn/currentPath only advance on a Ready configure — so an arm ack
            // resolves to whether playback is on (no re-configure needed; the player is already
            // armed). The path check still matters defensively for an EXPLICIT-path caller: no
            // production flow reaches this branch with a differing path (a turn-open derives its
            // path from turnMode and is always preceded by a mic-falling stop, so c.mic != micOn
            // there; a playback-axis sentinel resolves targetPath == currentPath by definition),
            // but it guards a future live path-flip on the SAME cell (e.g. an iOS engine switch
            // while mic+playback stay put) from silently collapsing with no log and no engine call.
            c.ack?.complete(c.playback)
            return
        }
        runCatching {
            val micRising = targetMic && !micOn
            val micFalling = !targetMic && micOn
            // audio.start BEFORE the engine + uplink come up (wire order: start→frames→end).
            // Carries this edge's TurnMode (Manual=hold / Semantic=continuous / null=semantic).
            if (micRising) onUplinkStart(c.turnMode)
            // Stop the uplink collect when mic goes away (before configure tears the tap).
            if (micFalling) pipeline?.stop()
            // THE single engine reconfig — VPIO flips iff the (mic,playback) cell changes.
            // Path-carrying overload: platform actuals that don't yet implement path-split
            // engines fall through the interface's default body to the 3-arg configure,
            // so this call is a pure parameter-threading change (no behavior change) until
            // S4/S5 land path-aware actuals.
            voiceAudio?.configure(targetMic, c.playback, targetPath)
            // configure never throws (failures become Phase.Error inside), so runCatching
            // completes normally even on a failure. On Phase.Error the actual reset the
            // engine graph to idle (failReset/failConfigure) — so RECONCILE the lane to
            // the same idle baseline (micOn=playbackOn=false), NOT the requested values.
            // Keeping the requested values would let a later arm(playback=true) collapse
            // as "already armed" against a torn-down engine → silent dropped TTS. Idle
            // baseline means any non-idle retry differs → re-attempts (M1's goal). The
            // tracked path resets to Duplex alongside — the next mic-rising edge (or an
            // explicit arm) re-derives/re-supplies it, so no stale Manual/Duplex lingers
            // against a torn-down engine.
            val phase = voiceAudio?.state?.value?.phase
            if (phase == Phase.Error) {
                log.warn("configure-error-reset-lane", mapOf("mic" to targetMic, "playback" to c.playback, "path" to targetPath.name, "reason" to (voiceAudio?.state?.value?.errorReason ?: "unknown")))
                micOn = false; playbackOn = false; currentPath = VoiceAudioPath.Duplex
                c.ack?.complete(false)
                return@runCatching
            }
            // Start the uplink collect once the mic tap is live.
            if (micRising) pipeline?.start()
            micOn = targetMic; playbackOn = c.playback; currentPath = targetPath
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
