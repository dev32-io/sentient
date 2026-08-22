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

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import io.sentient.mobilesdk.log.createLogger

class NetworkChangeObserver(
    private val appContext: Context,
    private val onChange: () -> Unit,
    private val onConnectivityRecovered: () -> Unit = {},
    private val onConnectivityUnavailable: () -> Unit = {},
) {
    private val log = createLogger("android", "net-change")
    private val cm =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val main = Handler(Looper.getMainLooper())
    private var activeNetwork: Network? = cm?.activeNetwork
    private val recoveryEdge = ConnectivityRecoveryEdge(
        initiallyAvailable = if (
            Settings.Global.getInt(appContext.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) == 1
        ) {
            false
        } else {
            activeNetwork?.let { network -> cm?.getNetworkCapabilities(network).isUsableInternet() } ?: false
        },
    )
    @Volatile private var started = false
    private var recoveryProbe: ConnectivityManager.NetworkCallback? = null

    private val airplaneModeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_AIRPLANE_MODE_CHANGED) return
            if (intent.getBooleanExtra("state", false)) {
                dispatch(markAirplaneModeUnavailable())
            } else {
                armValidatedRecoveryProbe()
            }
        }
    }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            dispatch(markAvailable(network))
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            dispatch(markCapabilities(network, capabilities))
        }

        override fun onLost(network: Network) {
            dispatch(markLost(network))
        }
    }

    @Synchronized
    private fun markAvailable(network: Network): ConnectivityTransition {
        val pathChanged = activeNetwork != network
        activeNetwork = network
        // Capability delivery can race before onAvailable and is not guaranteed
        // to repeat. Snapshot the newly active path here; a later capability
        // callback remains an idempotent fallback.
        val availability = recoveryEdge.update(
            available = cm?.getNetworkCapabilities(network).isUsableInternet(),
        )
        return ConnectivityTransition(
            changed = pathChanged || availability.changed,
            recovered = availability.recovered,
        )
    }

    @Synchronized
    private fun markCapabilities(network: Network, capabilities: NetworkCapabilities): ConnectivityTransition {
        if (activeNetwork != network || !capabilities.isUsableInternet()) {
            // Validation can flap while one available network is settling. Only
            // an actual onLost transition arms another recovery edge.
            return ConnectivityTransition(changed = false, recovered = false)
        }
        return recoveryEdge.update(available = true)
    }

    @Synchronized
    private fun markLost(network: Network): ConnectivityTransition {
        if (activeNetwork != network) return ConnectivityTransition(changed = false, recovered = false)
        val replacement = cm?.activeNetwork
        if (replacement != null && replacement != network) {
            // A handoff is not a second outage. Airplane-mode loss is armed by
            // its platform broadcast; a genuine no-replacement loss reaches
            // the unavailable reducer below.
            activeNetwork = replacement
            return ConnectivityTransition(changed = true, recovered = false)
        }
        activeNetwork = null
        val transition = recoveryEdge.update(available = false)
        return transition.copy(unavailable = transition.changed)
    }

    @Synchronized
    private fun markAirplaneModeUnavailable(): ConnectivityTransition {
        val transition = recoveryEdge.update(available = false)
        return transition.copy(unavailable = transition.changed)
    }

    private fun armValidatedRecoveryProbe() {
        val manager = cm ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val transition = synchronized(this@NetworkChangeObserver) {
                    activeNetwork = network
                    recoveryEdge.update(available = true)
                }
                dispatch(transition)
                main.post { clearRecoveryProbe(this) }
            }
        }
        synchronized(this) {
            recoveryProbe?.let { runCatching { manager.unregisterNetworkCallback(it) } }
            recoveryProbe = callback
        }
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()
        try {
            manager.registerNetworkCallback(request, callback)
        } catch (failure: Throwable) {
            clearRecoveryProbe(callback)
            log.warn(
                "recovery-probe.failed",
                mapOf("errorType" to (failure::class.simpleName ?: "unknown")),
            )
        }
    }

    @Synchronized
    private fun clearRecoveryProbe(callback: ConnectivityManager.NetworkCallback) {
        if (recoveryProbe !== callback) return
        recoveryProbe = null
        runCatching { cm?.unregisterNetworkCallback(callback) }
    }

    private fun dispatch(transition: ConnectivityTransition) {
        if (!transition.changed || !started) return
        log.info(if (transition.recovered) "network-recovered" else "network-unavailable")
        main.post {
            if (!started) return@post
            onChange()
            if (transition.unavailable) onConnectivityUnavailable()
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
            appContext.registerReceiver(airplaneModeReceiver, IntentFilter(Intent.ACTION_AIRPLANE_MODE_CHANGED))
        } catch (failure: Throwable) {
            runCatching { manager.unregisterNetworkCallback(callback) }
            started = false
            throw failure
        }
        log.info("start")
    }

    fun stop() {
        if (!started) return
        started = false
        cm?.unregisterNetworkCallback(callback)
        recoveryProbe?.let(::clearRecoveryProbe)
        runCatching { appContext.unregisterReceiver(airplaneModeReceiver) }
        log.info("stop")
    }
}

private fun NetworkCapabilities?.isUsableInternet(): Boolean = this != null &&
    hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
    hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

internal data class ConnectivityTransition(
    val changed: Boolean,
    val recovered: Boolean,
    val unavailable: Boolean = false,
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
