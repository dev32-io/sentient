// ---------------------------------------------------------------------------
// SdkFaultHolder — DEBUG-only weak reference to the active SentientSdk.
//
// Updated whenever UserSessionManager builds a new SDK (component()).
// DebugFaultReceiver reads it to arm faults via sdk.devFaults(). Guarded by
// BuildConfig.DEBUG so no reference leaks into release builds.
//
// Thread safety: all access is from the Main thread (Compose composition +
// BroadcastReceiver.onReceive both run on Main). WeakReference avoids
// preventing session GC after logout.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import io.sentient.mobilesdk.sdk.SentientSdk
import java.lang.ref.WeakReference

object SdkFaultHolder {
    private var ref: WeakReference<SentientSdk>? = null

    fun set(sdk: SentientSdk) {
        ref = WeakReference(sdk)
    }

    fun get(): SentientSdk? = ref?.get()

    fun clear() {
        ref = null
    }
}
