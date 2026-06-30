package io.sentient.mobilesdk.voice

/** 20ms of 16kHz mono PCM = 320 samples — the uplink frame quantum + Opus frame size. */
const val FRAME_SAMPLES_16K = 320

/** Reactive mic-engine state for the UI (spinner on Initializing, mic-active on Live). */
sealed interface MicState {
    data object Idle : MicState
    data object Initializing : MicState
    data object Live : MicState
    data class Error(val reason: String) : MicState
}
