// ---------------------------------------------------------------------------
// NetworkChangeObserver — persistent default-network callback. Fires `onChange`
// whenever the active default network changes (VPN→WiFi, WiFi→cellular, loss/regain).
//
// Why: a path change under a half-open socket leaves the SDK at READY on a dead
// socket, so a queued send is stuck on "Retry". This re-checks the socket on change.
// The FIRST onAvailable (the network at registration) is skipped — the SDK is already
// connecting. Requires ACCESS_NETWORK_STATE (declared in the manifest).
// ---------------------------------------------------------------------------
package io.sentient.android.presence

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import io.sentient.mobilesdk.log.createLogger

class NetworkChangeObserver(
    appContext: Context,
    private val onChange: () -> Unit,
) {
    private val log = createLogger("android", "net-change")
    private val cm =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val main = Handler(Looper.getMainLooper())
    private var sawFirst = false
    private var started = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            if (!sawFirst) {
                sawFirst = true
                log.info("initial-network (skip)")
                return
            }
            log.info("network-available → ensureConnected")
            main.post { onChange() }
        }

        override fun onLost(network: Network) {
            log.info("network-lost → ensureConnected")
            main.post { onChange() }
        }
    }

    fun start() {
        if (started) return
        val manager = cm ?: run {
            log.warn("start.skip", mapOf("reason" to "no-ConnectivityManager"))
            return
        }
        manager.registerDefaultNetworkCallback(callback)
        started = true
        log.info("start")
    }

    fun stop() {
        if (!started) return
        started = false
        cm?.unregisterNetworkCallback(callback)
        log.info("stop")
    }
}
