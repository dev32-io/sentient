package io.sentient.mobiledata.di

import io.sentient.mobilesdk.protocol.SdkEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** IO-free iOS ABI probe, following the Calendar bridge probe; not SDK delivery. */
fun captureStartFailureBridgeProbe(): Flow<SdkEvent.CaptureStartFailed> = flow {
    emit(SdkEvent.CaptureStartFailed("bridge-capture", 1L, 7L))
    emit(SdkEvent.CaptureStartFailed("bridge-unbound", 2L, null))
}
