package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * Test double. Bounded SUSPEND channel models the real producer-side drop-newest:
 * emit() == trySend(), which returns false when the buffer is full (frame dropped).
 * A DROP_LATEST channel would make trySend ALWAYS succeed and hide the drop — see
 * the Global Constraints backpressure note.
 */
class FakeMicSource(channelCapacity: Int = 8) : MicSource {
    private val ch = Channel<ShortArray>(capacity = channelCapacity)
    private val _state = MutableStateFlow<MicState>(MicState.Idle)
    override val frames = ch.receiveAsFlow()
    override val state: StateFlow<MicState> = _state
    override suspend fun start() { _state.value = MicState.Live }
    override suspend fun stop() { _state.value = MicState.Idle }

    /** Push a frame; returns false if dropped (channel full) — drop-newest. */
    fun emit(pcm: ShortArray): Boolean = ch.trySend(pcm).isSuccess
}
