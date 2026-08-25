package io.sentient.mobilesdk.voice

import io.sentient.mobilesdk.audio.opus.OpusEncoderPort
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

private const val TRACE_FIRST = 5
private const val TRACE_EVERY = 50

/**
 * Real-time uplink: micFrames (16k PCM16) → Framer (20ms) → OnsetDetector (barge-in edge)
 * → Opus encode → sendPacket 1:1. Runs on [dispatcher] (a dedicated single thread), NEVER
 * the SDK orchestrator. sendPacket is the WS binary sink (paced by the capture clock).
 *
 * The pipeline does NOT own mic activation — [VoiceAudio.configure] does. [micFrames] is
 * hot ONLY while micActive, so the collect job simply forwards what the engine emits; the
 * pipeline is dormant until a caller drives configure(mic=true) (Task 9).
 */
class VoiceUplinkPipeline(
    private val micFrames: Flow<ShortArray>,
    private val encoder: OpusEncoderPort,
    private val sendPacket: (ByteArray) -> Unit,
    private val onOnset: () -> Unit,
    private val scope: CoroutineScope,
    private val dispatcher: CoroutineDispatcher,
    private val framer: Framer,
    private val onset: OnsetDetector,
) {
    private val log = createLogger("voice", "uplink")
    private var job: Job? = null
    private var capturePacketSink: ((ByteArray) -> Unit)? = null
    private var framesIn = 0
    private var packetsOut = 0

    suspend fun start(packetSink: ((ByteArray) -> Unit)? = null) {
        if (job?.isActive == true) return
        capturePacketSink = packetSink ?: sendPacket
        framer.reset(); onset.reset(); encoder.reset(); framesIn = 0; packetsOut = 0
        // No mic.start() — VoiceAudio.configure owns mic activation; micFrames is hot
        // ONLY while micActive, so the collect job simply forwards what the engine emits.
        job = scope.launch(dispatcher) {
            micFrames.collect { pcm -> onPcm(pcm) }
        }
    }

    suspend fun stop() {
        // cancelAndJoin (not cancel): wait for any in-flight onPcm encode on the
        // dispatcher thread to finish before encoder.reset(), so reset() can never
        // race a concurrent encode of the non-thread-safe encoder/Framer.
        job?.cancelAndJoin(); job = null
        capturePacketSink = null
        encoder.reset()
        // No mic.stop() — configure(mic=false) owns teardown.
    }

    private fun onPcm(pcm: ShortArray) {
        for (frame in framer.push(pcm)) {
            framesIn += 1
            if (onset.observe(frame)) onOnset()
            for (packet in encoder.encode(frame)) {
                capturePacketSink?.invoke(packet)
                packetsOut += 1
            }
        }
        if (framesIn <= TRACE_FIRST || framesIn % TRACE_EVERY == 0) {
            log.debug("uplink", mapOf("framesIn" to framesIn, "packetsOut" to packetsOut))
        }
    }
}
