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
    private val onConnectivityRecovered: () -> Unit = {},
) {
    private val log = createLogger("android", "net-change")
    private val cm =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val main = Handler(Looper.getMainLooper())
    private var activeNetwork: Network? = cm?.activeNetwork
    private val recoveryEdge = ConnectivityRecoveryEdge(activeNetwork != null)
    @Volatile private var started = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            dispatch(markAvailable(network))
        }

        override fun onLost(network: Network) {
            dispatch(markLost(network))
        }
    }

    @Synchronized
    private fun markAvailable(network: Network): ConnectivityTransition {
        val pathChanged = activeNetwork != network
        activeNetwork = network
        val availability = recoveryEdge.update(available = true)
        return ConnectivityTransition(
            changed = pathChanged || availability.changed,
            recovered = availability.recovered,
        )
    }

    @Synchronized
    private fun markLost(network: Network): ConnectivityTransition {
        if (activeNetwork != network) return ConnectivityTransition(changed = false, recovered = false)
        activeNetwork = null
        return recoveryEdge.update(available = false)
    }

    private fun dispatch(transition: ConnectivityTransition) {
        if (!transition.changed || !started) return
        log.info(if (transition.recovered) "network-recovered" else "network-unavailable")
        main.post {
            if (!started) return@post
            onChange()
            if (transition.recovered) onConnectivityRecovered()
        }
    }

    fun start() {
        if (started) return
        val manager = cm ?: run {
            log.warn("start.skip", mapOf("reason" to "no-ConnectivityManager"))
            return
        }
        started = true
        try {
            manager.registerDefaultNetworkCallback(callback)
        } catch (failure: Throwable) {
            started = false
            throw failure
        }
        log.info("start")
    }

    fun stop() {
        if (!started) return
        started = false
        cm?.unregisterNetworkCallback(callback)
        log.info("stop")
    }
}

internal data class ConnectivityTransition(
    val changed: Boolean,
    val recovered: Boolean,
)

/** Serial availability reducer used by the platform callback; duplicates never signal recovery. */
internal class ConnectivityRecoveryEdge(initiallyAvailable: Boolean?) {
    private var available: Boolean? = initiallyAvailable

    @Synchronized
    fun update(available: Boolean): ConnectivityTransition {
        val previous = this.available
        this.available = available
        if (previous == null || previous == available) {
            return ConnectivityTransition(changed = false, recovered = false)
        }
        return ConnectivityTransition(changed = true, recovered = !previous && available)
    }
}
