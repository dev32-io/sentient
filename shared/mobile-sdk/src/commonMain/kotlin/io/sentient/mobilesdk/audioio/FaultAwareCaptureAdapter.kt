// ---------------------------------------------------------------------------
// FaultAwareCaptureAdapter — DEBUG-only AudioCaptureAdapter wrapper.
//
// When a fixture utterance has been loaded via FaultHooks.loadFixtureUtterance,
// the first call to frames() emits the fixture PCM bytes as a single frame
// then falls through to the real adapter's frames (allowing STT to process the
// utterance). On all other calls, delegates transparently to the real adapter.
//
// This enables the Maestro voice-loop E2E flow to inject a known audio payload
// into the uplink pipeline without a physical mic or manual speech.
//
// Arm via (after loadFixtureUtterance is called through the BroadcastReceiver
// or direct sdk.devFaults().loadFixtureUtterance(pcmBytes)):
//   - The next startMic() + frames() call emits the fixture once.
//   - The real mic continues after the fixture drains (or stop() is called).
//
// Thread safety: flow collection and FaultHooks access are both on the scope
// that drives AudioPipeline (Dispatchers.Default.limitedParallelism(1)).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.dev.FaultHooks
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion

private val log = createLogger("audioio", "fault-aware-capture")

/**
 * Wraps a real [AudioCaptureAdapter] with debug fixture-utterance injection.
 *
 * @param real The real platform capture adapter.
 * @param faultHooks Debug fault hooks; null unless devFaultsEnabled (release guard).
 */
class FaultAwareCaptureAdapter(
    private val real: AudioCaptureAdapter,
    private val faultHooks: FaultHooks,
) : AudioCaptureAdapter {

    override suspend fun start(sampleRate: Int) = real.start(sampleRate)

    override suspend fun stop() = real.stop()

    override fun frames(sampleRate: Int): Flow<ByteArray> {
        val fixture = faultHooks.takeFixtureUtterance()
        return if (fixture != null) {
            log.info("fixture-utterance", mapOf("bytes" to fixture.size, "sampleRate" to sampleRate))
            flow {
                // Emit the fixture as a single contiguous PCM16 frame.
                // The uplink re-chunker (OpusUplinkEncoder) will split it into 20ms packets.
                emit(fixture)
                // After the fixture, drain the real adapter so the pipeline
                // doesn't hang waiting for more frames. The SpeechGate will close
                // naturally when transcript.final arrives from the STT server.
                real.frames(sampleRate).collect { emit(it) }
            }.onCompletion { log.info("fixture-utterance.done") }
        } else {
            real.frames(sampleRate)
        }
    }
}
