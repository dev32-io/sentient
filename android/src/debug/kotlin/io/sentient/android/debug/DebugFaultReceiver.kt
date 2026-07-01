// ---------------------------------------------------------------------------
// DebugFaultReceiver — DEBUG-only BroadcastReceiver for E2E fault injection.
//
// Arms faults on the active SentientSdk via sdk.devFaults() when triggered by:
//
//   adb shell am broadcast -a io.sentient.debug.FAULT --es kind expired
//   adb shell am broadcast -a io.sentient.debug.FAULT --es kind malformed
//
// Registered in the debug-variant AndroidManifest so it is ABSENT from release
// builds. The receiver is exported=false — only adb shell / the local device
// process can send this broadcast.
//
// Flow-integration:
//   20-malformed-frame: arm via broadcast → send a message → logcat grep
//     "fault.malformed-frame" and "decode-failed" confirms the ProtocolError path.
//   18-auth-expired: arm via broadcast → trigger connect/reconnect cycle → the
//     next auth.ok is intercepted as an auth failure → SDK routes to ERROR +
//     authExpired → MainActivity shows login screen.
// ---------------------------------------------------------------------------
package io.sentient.android.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.sentient.android.sdk.SdkFaultHolder
import io.sentient.mobilesdk.log.createLogger

private val log = createLogger("android", "debug", "fault-receiver")

class DebugFaultReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val kind = intent.getStringExtra("kind") ?: run {
            log.warn("fault.broadcast.missing-kind", mapOf("action" to (intent.action ?: "")))
            return
        }
        val sdk = SdkFaultHolder.get() ?: run {
            log.warn("fault.broadcast.no-active-sdk", mapOf("kind" to kind))
            return
        }
        val faults = sdk.devFaults() ?: run {
            log.warn("fault.broadcast.devFaults-null", mapOf("kind" to kind, "reason" to "devFaultsEnabled=false"))
            return
        }
        when (kind) {
            "expired" -> {
                faults.armExpiredToken()
                log.info("fault.arm", mapOf("kind" to "expired-token"))
            }
            "malformed" -> {
                faults.armMalformedFrame()
                log.info("fault.arm", mapOf("kind" to "malformed-frame"))
            }
            else -> log.warn("fault.broadcast.unknown-kind", mapOf("kind" to kind))
        }
    }
}
