package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Platform mic capture primitive. Captures + resamples to 16k mono PCM16 on a dedicated
 * realtime thread and exposes frames as a cold-ish Flow backed by a bounded drop-newest
 * channel. Owns device + (iOS) the shared full-duplex engine. Never runs on the SDK
 * orchestrator coroutine.
 */
interface MicSource {
    val frames: Flow<ShortArray>
    val state: StateFlow<MicState>
    suspend fun start()
    suspend fun stop()
}
